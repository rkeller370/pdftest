const fs = require("fs");
const path = require("path");
const os = require("os");
const axios = require("axios");
const { PDFParse } = require("pdf-parse");
require("dotenv").config();

let ocrOverride = false;

const INPUT_DIR = "./input_pdfs";
const OUTPUT_DIR = "./output";
const CONCURRENCY = Math.max(1, os.cpus().length - 1);
const MIN_CHARS_PER_PAGE = 50;

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

class TextStructureAnalyzer {
  constructor(rawText) {
    this.lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(l => l);
    this.stats = this.analyzeDocument();
  }

  analyzeDocument() {
    const lengths = this.lines.map(l => l.length);
    const avgLength = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const medianLength = this.median(lengths);
    const sentenceEndings = this.lines.filter(l => /[.!?]$/.test(l)).length;
    const colonEndings = this.lines.filter(l => /:$/.test(l)).length;
    
    return {
      avgLength,
      medianLength,
      sentenceEndingRatio: sentenceEndings / this.lines.length,
      colonEndingRatio: colonEndings / this.lines.length,
      totalLines: this.lines.length
    };
  }

  median(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  isHeaderLine(line, index) {
    const factors = [];
    const lengthThreshold = Math.min(this.stats.medianLength * 0.6, 80);
    if (line.length < lengthThreshold) factors.push(1);
    
    const words = line.split(/\s+/);
    const isAllCaps = line === line.toUpperCase() && 
                      /[A-Z]/.test(line) && 
                      words.length > 1 &&
                      words.length < 12;
    if (isAllCaps) factors.push(2);
    
    const capitalizedWords = words.filter(w => /^[A-Z]/.test(w) && w.length > 2);
    const isTitleCase = capitalizedWords.length >= words.length * 0.7 && 
                        words.length >= 2 && 
                        words.length < 15;
    if (isTitleCase && !this.endsWithPunctuation(line)) factors.push(1.5);
    
    if (!this.endsWithPunctuation(line) && line.length < 100) factors.push(1);
    if (/:$/.test(line)) factors.push(2);
    if (/^(\d+\.|\d+\)|\-|\*|•)\s+[A-Z]/.test(line) && line.length < 100) factors.push(1.5);
    
    const prevLine = index > 0 ? this.lines[index - 1] : "";
    const nextLine = index < this.lines.length - 1 ? this.lines[index + 1] : "";
    if (prevLine.length > line.length * 1.5 || nextLine.length > line.length * 1.5) {
      factors.push(0.5);
    }
    
    const headerPatterns = [
      /^(chapter|section|part|appendix|introduction|conclusion|abstract|summary|overview|background)/i,
      /^(table of contents|references|bibliography|acknowledgments)/i,
      /^\d+\.\s+[A-Z]/,
      /^[IVXLCDM]+\.\s+[A-Z]/
    ];
    if (headerPatterns.some(p => p.test(line))) factors.push(2);
    
    const score = factors.reduce((a, b) => a + b, 0);
    return score >= 2.5;
  }

  isListItem(line) {
    return /^(\d+\.|\d+\)|\-|\*|•|○|§|[a-z]\.|[A-Z]\.)\s+/.test(line);
  }

  isContinuation(line) {
    return !this.isListItem(line) && 
           /^[a-z]/.test(line) && 
           !this.isHeaderLine(line, -1);
  }

  endsWithPunctuation(line) {
    return /[.!?;]$/.test(line);
  }

  startsWithCapital(line) {
    return /^[A-Z"'([]/.test(line);
  }
}

function cleanNaturalText(rawText) {
  if (!rawText) return "";

  const analyzer = new TextStructureAnalyzer(rawText);
  const lines = analyzer.lines;
  const blocks = [];
  let currentBlock = { type: 'paragraph', lines: [] };
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (analyzer.isHeaderLine(line, i)) {
      if (currentBlock.lines.length > 0) {
        blocks.push(currentBlock);
      }
      blocks.push({
        type: 'header',
        lines: [line],
        level: line.length < 30 ? 1 : line.length < 60 ? 2 : 3
      });
      currentBlock = { type: 'paragraph', lines: [] };
      continue;
    }
    
    if (analyzer.isListItem(line)) {
      if (currentBlock.type === 'paragraph' && currentBlock.lines.length > 0) {
        blocks.push(currentBlock);
        currentBlock = { type: 'list', lines: [] };
      }
      if (currentBlock.type !== 'list') {
        currentBlock = { type: 'list', lines: [] };
      }
      currentBlock.lines.push(line);
      continue;
    }
    
    if (currentBlock.type === 'list' && currentBlock.lines.length > 0) {
      blocks.push(currentBlock);
      currentBlock = { type: 'paragraph', lines: [] };
    }
    
    if (currentBlock.lines.length > 0) {
      const lastLine = currentBlock.lines[currentBlock.lines.length - 1];
      const shouldMerge = 
        !analyzer.endsWithPunctuation(lastLine) || 
        analyzer.isContinuation(line) ||  
        (lastLine.length < 80 && !analyzer.startsWithCapital(line));
      
      if (shouldMerge) {
        currentBlock.lines[currentBlock.lines.length - 1] = lastLine + " " + line;
      } else {
        currentBlock.lines.push(line);
      }
    } else {
      currentBlock.lines.push(line);
    }
  }
  
  if (currentBlock.lines.length > 0) {
    blocks.push(currentBlock);
  }
  
  return blocks.map(block => {
    if (block.type === 'header') {
      const hashes = '#'.repeat(block.level);
      return `\n${hashes} ${block.lines[0].toUpperCase()} ${hashes}\n`;
    } else if (block.type === 'list') {
      return block.lines.join('\n');
    } else {
      return block.lines.join(' ');
    }
  }).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function cleanPages(pages) {
  return pages.map((page, idx) => {
    let cleaned = cleanNaturalText(page.text);
    cleaned = cleaned.replace(/\f/g, '');
    cleaned = cleaned.replace(/Page \d+ of \d+/gi, '');
    cleaned = cleaned.replace(/^\d+\s*$/gm, '');
    cleaned = cleaned.replace(/^[\s\-_]+$/gm, '');
    
    return {
      pageNumber: idx + 1,
      text: cleaned
    };
  }).filter(p => p.text.trim().length >= MIN_CHARS_PER_PAGE);
}

async function processSinglePDF(file) {
  const start = Date.now();
  const pdfPath = path.join(INPUT_DIR, file);
  const base = file.replace(".pdf", "");

  try {
    let pages = await extractPdfParse(pdfPath);
    let usable = pages.some(p => p.text.length >= MIN_CHARS_PER_PAGE);
    let method = "pdf-parse";

    if (!usable || ocrOverride) {
      pages = await extractAzure(pdfPath);
      method = "azure";
    }

    const cleanedPages = cleanPages(pages);
    
    const output = [
      `# Document: ${file}`,
      `# Processed: ${new Date().toISOString()}`,
      `# Method: ${method}`,
      `# Pages: ${cleanedPages.length}`,
      `\n${'='.repeat(80)}\n`,
      ...cleanedPages.map(p => 
        `\n## Page ${p.pageNumber}\n${'-'.repeat(80)}\n\n${p.text}`
      )
    ].join('\n');

    fs.writeFileSync(`${OUTPUT_DIR}/${base}.txt`, output);
    console.log(`✔ ${file} (${method}, ${cleanedPages.length} pages, ${Date.now() - start}ms)`);
  } catch (err) {
    console.error(`✖ ${file} failed: ${err.message}`);
    fs.writeFileSync(`${OUTPUT_DIR}/${base}.error.txt`, err.stack);
  }
}

async function extractPdfParse(pdfPath) {
  const buffer = fs.readFileSync(pdfPath);
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();

  if (Array.isArray(result.pages) && result.pages.length > 0) {
    return result.pages.map((p, i) => ({ page: i + 1, text: p.text || "" }));
  }

  return result.text.split("\f").map((text, i) => ({
    page: i + 1,
    text: text
  })).filter(p => p.text.trim().length > 0);
}

async function extractAzure(pdfPath) {
  const file = fs.readFileSync(pdfPath);
  const submit = await axios.post(
    `${process.env.AZURE_ENDPOINT}/formrecognizer/documentModels/prebuilt-layout:analyze?api-version=2023-07-31`,
    file,
    {
      headers: {
        "Ocp-Apim-Subscription-Key": process.env.AZURE_KEY,
        "Content-Type": "application/pdf"
      }
    }
  );

  const pollUrl = submit.headers["operation-location"];
  let result;
  while (!result) {
    await sleep(1500);
    const poll = await axios.get(pollUrl, {
      headers: { "Ocp-Apim-Subscription-Key": process.env.AZURE_KEY }
    });
    if (poll.data.status === "succeeded") result = poll.data;
  }

  return result.analyzeResult.pages.map(page => ({
    page: page.pageNumber,
    text: page.lines.map(l => l.content).join("\n")
  }));
}

async function runQueue(items, limit, worker) {
  const queue = [...items];
  const workers = Array.from({ length: limit }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item) await worker(item);
    }
  });
  await Promise.all(workers);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const pdfFiles = fs.readdirSync(INPUT_DIR).filter(f => f.endsWith(".pdf"));
console.log(`Processing ${pdfFiles.length} PDF files with ${CONCURRENCY} workers...\n`);
runQueue(pdfFiles, CONCURRENCY, processSinglePDF);
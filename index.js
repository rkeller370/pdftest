const fs = require("fs");
const path = require("path");
const os = require("os");
const axios = require("axios");
const { PDFParse } = require("pdf-parse");
const Tokenizer = require("sentence-tokenizer");
const he = require("he");
require("dotenv").config();

let ocrOverride = false;

const INPUT_DIR = "./input_pdfs";
const OUTPUT_DIR = "./output";
const CONCURRENCY = Math.max(1, os.cpus().length - 1);
const MIN_CHARS_PER_PAGE = 50;

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

class TextStructureAnalyzer {
  constructor(rawText) {
    this.tokenizer = new Tokenizer();
    this.rawText = he.decode(rawText);
    this.lines = this.rawText.split(/\r?\n/).map(l => l.trim()).filter(l => l);
    this.stats = this.analyzeDocument();
  }

  analyzeDocument() {
    const lengths = this.lines.map(l => l.length);
    if (lengths.length === 0) return { medianLength: 0 };
    const sorted = [...lengths].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return { medianLength: median };
  }

  isHeaderLine(line, index) {
    if (line.length < 3 || line.length > 120) return false;
    let score = 0;
    const words = line.split(/\s+/);
    const isAllCaps = line === line.toUpperCase() && /[A-Z]/.test(line);

    if (isAllCaps && words.length <= 8) score += 4;
    if (/^[A-Z0-9][A-Z0-9\s\-\.]+$/.test(line) && line.length < 60) score += 2;
    if (/^(\d+\.|\d+\.\d+|[IVXLCDM]+\.)\s+[A-Z]/.test(line)) score += 3;
    if (line.endsWith(':') && line.length < 50) score += 2;
    if (/^#+\s/.test(line)) score += 5;

    const prevLine = index > 0 ? this.lines[index - 1] : "";
    const nextLine = index < this.lines.length - 1 ? this.lines[index + 1] : "";
    if (line.length < this.stats.medianLength * 0.7) {
        if (!/[.!?]$/.test(line)) score += 2;
    }

    return score >= 4;
  }

  isListItem(line) {
    return /^(\d+[\.\)]|[\-\*•○§]|([a-z]|[A-Z])[\.\)])\s+/u.test(line) || 
           /^[●○■□▶▷►▸▹◀◁◂◃▪▫\u2022]/.test(line);
  }

  shouldJoin(prevLine, currLine) {
    if (!prevLine) return false;
    if (this.isListItem(currLine) || this.isListItem(prevLine)) return false;
    const endsWithPunct = /[.!?;:]$/.test(prevLine);
    const startsWithLower = /^[a-z]/.test(currLine);
    if (startsWithLower) return true;
    if (!endsWithPunct && prevLine.length > this.stats.medianLength * 0.5) return true;
    return false;
  }
}

function processContent(rawText) {
  if (!rawText) return "";
  const analyzer = new TextStructureAnalyzer(rawText);
  const lines = analyzer.lines;
  const blocks = [];
  let currentParagraph = [];

  const flush = () => {
    if (currentParagraph.length > 0) {
      const text = currentParagraph.join(" ");
      analyzer.tokenizer.setEntry(text);
      blocks.push(analyzer.tokenizer.getSentences().join(" "));
      currentParagraph = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (analyzer.isHeaderLine(line, i)) {
      flush();
      blocks.push(`\n### ${line.toUpperCase()} ###\n`);
    } else if (analyzer.isListItem(line)) {
      flush();
      blocks.push(line);
    } else {
      if (currentParagraph.length > 0 && !analyzer.shouldJoin(currentParagraph[currentParagraph.length - 1], line)) {
        flush();
      }
      currentParagraph.push(line);
    }
  }
  flush();
  return blocks.join("\n\n").replace(/\n{3,}/g, '\n\n').trim();
}

function applyArtifactCleanup(text) {
    return text
        .replace(/\f/g, '')
        .replace(/Page \d+ of \d+/gi, '')
        .replace(/^\d+$/gm, '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
        .replace(/(\w)-\s*\n(\w)/g, "$1$2")
        .replace(/[ \t]+/g, " ");
}

async function processSinglePDF(file) {
  const start = Date.now();
  const pdfPath = path.join(INPUT_DIR, file);
  const base = path.parse(file).name;

  try {
    let pages = await extractPdfParse(pdfPath);
    let usable = pages.filter(p => p.text.trim().length >= MIN_CHARS_PER_PAGE).length / pages.length > 0.5;
    let method = "pdf-parse";

    if (!usable || ocrOverride) {
      pages = await extractAzure(pdfPath);
      method = "azure";
    }

    const processedPages = pages.map(p => ({
        ...p,
        text: applyArtifactCleanup(processContent(p.text))
    })).filter(p => p.text.length > 10);
    
    const output = [
      `# MANIFEST`,
      `SOURCE: ${file}`,
      `ENGINE: ${method}`,
      `DATE: ${new Date().toISOString()}`,
      `PAGES_EXTRACTED: ${processedPages.length}`,
      `\n${'#'.repeat(40)}\n`,
      ...processedPages.map(p => `[PAGE ${p.page}]\n${p.text}\n`)
    ].join('\n');

    fs.writeFileSync(path.join(OUTPUT_DIR, `${base}.txt`), output);
    console.log(`[SUCCESS] ${file} | ${method} | ${Date.now() - start}ms`);
  } catch (err) {
    console.error(`[FAILURE] ${file} | ${err.message}`);
    fs.writeFileSync(path.join(OUTPUT_DIR, `${base}.error.log`), err.stack);
  }
}

async function extractPdfParse(pdfPath) {
  const buffer = fs.readFileSync(pdfPath);
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  if (Array.isArray(result.pages)) {
    return result.pages.map((p, i) => ({ page: i + 1, text: p.text || "" }));
  }
  return result.text.split("\f").map((text, i) => ({ page: i + 1, text }));
}

async function extractAzureModern(pdfPath) {
  const file = fs.readFileSync(pdfPath);
  
  // Modern endpoint
  const endpoint = `${process.env.AZURE_ENDPOINT}/documentintelligence/documentModels/prebuilt-read:analyze`;
  const params = `api-version=2024-11-30-preview&features=ocr.highResolution`;
  
  const response = await axios.post(
    `${endpoint}?${params}`,
    file,
    {
      headers: {
        "Ocp-Apim-Subscription-Key": process.env.AZURE_KEY,
        "Content-Type": "application/pdf"
      }
    }
  );

  // Polling remains similar
  const pollUrl = response.headers["operation-location"];
  
  // New response parsing
  const result = await pollUntilComplete(pollUrl);
  
  return result.pages.map(page => ({
    page: page.pageNumber,
    text: page.paragraphs
      ? page.paragraphs.map(p => p.content).join("\n\n")
      : page.lines.map(l => l.content).join("\n")
  }));
}



// Update your extractAzure function:
async function extractAzure(pdfPath) {
  try {
    // Try modern endpoint first
    return await extractAzureModern(pdfPath);
  } catch (error) {
    if (error.response?.status === 404) {
      // Fallback to legacy endpoint if new one not available
      console.log("Falling back to legacy endpoint");
      throw error;
     // return await extractAzureLegacy(pdfPath); // Your current code
    }
    throw error;
  }
}

async function extractAzure(pdfPath) {
  const file = fs.readFileSync(pdfPath);
  const response = await axios.post(
    `${process.env.AZURE_ENDPOINT}/formrecognizer/documentModels/prebuilt-layout:analyze?api-version=2023-07-31`,
    file,
    {
      headers: {
        "Ocp-Apim-Subscription-Key": process.env.AZURE_KEY,
        "Content-Type": "application/pdf"
      }
    }
  );

  const pollUrl = response.headers["operation-location"];
  let result;
  while (true) {
    const poll = await axios.get(pollUrl, {
      headers: { "Ocp-Apim-Subscription-Key": process.env.AZURE_KEY }
    });
    if (poll.data.status === "succeeded") {
      result = poll.data;
      break;
    }
    if (poll.data.status === "failed") throw new Error("Azure OCR Failed");
    await sleep(2000);
  }

  return result.analyzeResult.pages.map(page => ({
    page: page.pageNumber,
    text: page.lines.map(l => l.content).join("\n")
  }));
}

async function runQueue(items, limit, worker) {
  const queue = [...items];
  const workers = Array.from({ length: limit }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) await worker(item);
    }
  });
  await Promise.all(workers);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const pdfFiles = fs.readdirSync(INPUT_DIR).filter(f => /\.pdf$/i.test(f));
console.log(`INIT: ${pdfFiles.length} files | ${CONCURRENCY} threads`);
runQueue(pdfFiles, CONCURRENCY, processSinglePDF);
if (typeof global.DOMMatrix === 'undefined') {
    global.DOMMatrix = class DOMMatrix {
        constructor() {
            this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
        }
    };
}

const fs = require("fs");
const path = require("path");
const os = require("os");
const axios = require("axios");
const { PDFParse } = require("pdf-parse");
const Tokenizer = require("sentence-tokenizer");
const he = require("he");
require("dotenv").config();

const INPUT_DIR = "./input_pdfs";
const OUTPUT_DIR = "./output";
const NORMAL_DIR = "./"
const CSV_OUTPUT = path.join(NORMAL_DIR, "file_manifest.csv");
const CONCURRENCY = Math.max(1, os.cpus().length - 1);
const MIN_CHARS_PER_PAGE = 50;
const DATA_JSON = "./pdf.json";

if (!fs.existsSync(INPUT_DIR)) fs.mkdirSync(INPUT_DIR);
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

class DocumentHeuristics {
    static isHeader(line, stats) {
        if (!line || line.length < 3) return false;
        let score = 0;
        const words = line.split(/\s+/);
        const isAllCaps = line === line.toUpperCase() && /[A-Z]/.test(line);
        const hasNumbering = /^(\d+\.|\d+\.\d+|[IVXLCDM]+\.)\s+/.test(line);

        if (isAllCaps) score += 4;
        if (hasNumbering) score += 3;
        if (words.length <= 10) score += 2;
        if (!/[.!?]$/.test(line)) score += 2;
        if (line.length < stats.medianLength * 0.6) score += 2;
        if (/^#+\s/.test(line)) score += 10;

        return score >= 6;
    }

    static isList(line) {
        return /^(\d+[\.\)]|[\-\*•○§]|([a-z]|[A-Z])[\.\)])\s+/u.test(line) || 
               /^[●○■□▶▷►▸▹◀◁◂◃▪▫\u2022]/.test(line);
    }

    static isPageNumber(line) {
        return /^\d+$/.test(line) || /page\s+\d+\s+of\s+\d+/i.test(line);
    }
}

class SemanticBuffer {
    constructor() {
        this.nodes = [];
    }

    add(type, content) {
        if (!content.trim()) return;
        this.nodes.push({ type, content: content.trim() });
    }

    reorderOrphanedHeaders() {
        for (let i = 0; i < this.nodes.length; i++) {
            if (this.nodes[i].type === 'header' && i === this.nodes.length - 1) {
                this.nodes[i].type = 'paragraph';
            }
        }
    }

    render() {
        this.reorderOrphanedHeaders();
        return this.nodes.map(n => {
            if (n.type === 'header') return `\n### ${n.content.toUpperCase()} ###\n`;
            if (n.type === 'list') return n.content;
            return n.content;
        }).join("\n\n");
    }
}

class DocumentProcessor {
    constructor(rawText) {
        this.tokenizer = new Tokenizer();
        this.lines = he.decode(rawText).split(/\r?\n/).map(l => l.trim());
        this.stats = this.calculateStats();
        this.buffer = new SemanticBuffer();
    }

    calculateStats() {
        const lengths = this.lines.filter(l => l.length > 5).map(l => l.length);
        if (lengths.length === 0) return { medianLength: 0 };
        const sorted = [...lengths].sort((a, b) => a - b);
        return { medianLength: sorted[Math.floor(sorted.length / 2)] };
    }

    process() {
        let currentPara = [];

        const flushPara = () => {
            if (currentPara.length > 0) {
                this.tokenizer.setEntry(currentPara.join(" "));
                this.buffer.add('paragraph', this.tokenizer.getSentences().join(" "));
                currentPara = [];
            }
        };

        this.lines.forEach((line, idx) => {
            if (DocumentHeuristics.isPageNumber(line)) return;

            if (DocumentHeuristics.isHeader(line, this.stats)) {
                flushPara();
                this.buffer.add('header', line);
            } else if (DocumentHeuristics.isList(line)) {
                flushPara();
                this.buffer.add('list', line);
            } else {
                if (currentPara.length > 0) {
                    const prev = currentPara[currentPara.length - 1];
                    const shouldJoin = /^[a-z]/.test(line) || (!/[.!?;:]$/.test(prev) && prev.length > this.stats.medianLength * 0.5);
                    if (!shouldJoin) flushPara();
                }
                currentPara.push(line);
            }
        });

        flushPara();
        return this.buffer.render();
    }
}

function cleanText(text) {
    return text
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
        .replace(/(\w)-\s*\n(\w)/g, "$1$2")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, '\n\n');
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
        if (poll.data.status === "failed") throw new Error("Azure OCR Failure");
        await new Promise(r => setTimeout(r, 2000));
    }

    return result.analyzeResult.pages.map(page => ({
        page: page.pageNumber,
        text: page.lines.map(l => l.content).join("\n")
    }));
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

async function downloadFile(url, targetPath) {
    const response = await axios({ url, method: 'GET', responseType: 'stream' });
    const writer = fs.createWriteStream(targetPath);
    response.data.pipe(writer);
    return new Promise((res, rej) => {
        writer.on('finish', res);
        writer.on('error', rej);
    });
}

async function processEntry(entry) {
    const safeName = entry.file_name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const fileName = `${safeName}.txt`;
    const pdfPath = path.join(INPUT_DIR, `${safeName}.pdf`);
    const outputPath = path.join(OUTPUT_DIR, fileName);

    if (fs.existsSync(outputPath)) {
        console.log(`[SKIP] ${entry.file_name} already exists.`);
        return { fileName, originalPdf: entry.pdf_link };
    }

    try {
        if (!fs.existsSync(pdfPath)) await downloadFile(entry.pdf_link, pdfPath);

        let pages;
        let method = "pdf-parse";
        const forceOCR = entry.manual_ocr === true || entry.manual_ocr === "true";

        if (forceOCR) {
            pages = await extractAzure(pdfPath);
            method = "azure-forced";
        } else {
            pages = await extractPdfParse(pdfPath);
            const quality = pages.filter(p => p.text.trim().length >= MIN_CHARS_PER_PAGE).length / pages.length;
            if (quality < 0.5) {
                pages = await extractAzure(pdfPath);
                method = "azure-fallback";
            }
        }

        const processed = pages.map(p => {
            const engine = new DocumentProcessor(p.text);
            return `[PAGE ${p.page}]\n${cleanText(engine.process())}\n`;
        });

        const manifest = [
            `# MANIFEST`,
            `SOURCE: ${entry.file_name}`,
            `METHOD: ${method}`,
            `STAMP: ${new Date().toISOString()}`,
            `\n${'='.repeat(50)}\n`,
            ...processed
        ].join('\n');

        fs.writeFileSync(outputPath, manifest);
        console.log(`[DONE] ${entry.file_name} via ${method}`);
        return { fileName, originalPdf: entry.pdf_link };
    } catch (err) {
        console.error(`[ERR] ${entry.file_name}: ${err.message}`);
        return null;
    }
}

async function run(items, limit, worker) {
    const queue = [...items];
    const results = [];
    const pool = Array.from({ length: limit }, async () => {
        while (queue.length > 0) {
            const item = queue.shift();
            if (item) {
                const result = await worker(item);
                if (result) results.push(result);
            }
        }
    });
    await Promise.all(pool);
    return results;
}

const config = JSON.parse(fs.readFileSync(DATA_JSON, "utf8"));

run(config.pdf_links, CONCURRENCY, processEntry).then((processedFiles) => {
    const GITHUB_BASE = "https://github.com/rkeller370/pdftest/blob/main/output/";
    
    let csvContent = "filename,github_url,original_pdf_url\n";
    processedFiles.forEach(item => {
        const fullUrl = `${GITHUB_BASE}${item.fileName}`;
        csvContent += `${item.fileName},${fullUrl},${item.originalPdf}\n`;
    });

    fs.writeFileSync(CSV_OUTPUT, csvContent);
    console.log(`\n--- Processing Complete ---`);
    console.log(`CSV Manifest created at: ${CSV_OUTPUT}`);
});
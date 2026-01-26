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
const OUTPUT_DIR = "./output_html";
const CONCURRENCY = Math.max(1, os.cpus().length - 1);
const MIN_CHARS_PER_PAGE = 50;
const DATA_JSON = "./pdf.json";

if (!fs.existsSync(INPUT_DIR)) fs.mkdirSync(INPUT_DIR);
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

class DocumentHeuristics {
    static isHeader(line, stats) {
        if (!line || line.length < 3) return false;
        let score = 0;
        const isAllCaps = line === line.toUpperCase() && /[A-Z]/.test(line);
        const hasNumbering = /^(\d+\.|\d+\.\d+|[IVXLCDM]+\.)\s+/.test(line);

        if (isAllCaps) score += 4;
        if (hasNumbering) score += 3;
        if (line.split(/\s+/).length <= 10) score += 2;
        if (!/[.!?]$/.test(line)) score += 2;
        if (line.length < stats.medianLength * 0.6) score += 2;
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

    render() {
        let html = "";
        let inList = false;

        this.nodes.forEach((node, i) => {
            if (node.type === 'list') {
                if (!inList) {
                    html += "<ul>\n";
                    inList = true;
                }
                html += `  <li>${he.encode(node.content.replace(/^[•\-\*\d\.\)]+\s+/, ""))}</li>\n`;
            } else {
                if (inList) {
                    html += "</ul>\n";
                    inList = false;
                }
                if (node.type === 'header') {
                    const level = i === 0 ? 1 : 2;
                    html += `<h${level}>${he.encode(node.content)}</h${level}>\n`;
                } else {
                    html += `<p>${he.encode(node.content)}</p>\n`;
                }
            }
        });

        if (inList) html += "</ul>\n";
        return html;
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

        this.lines.forEach(line => {
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

async function extractAzure(pdfPath) {
    const file = fs.readFileSync(pdfPath);
    const response = await axios.post(
        `${process.env.AZURE_ENDPOINT}/formrecognizer/documentModels/prebuilt-layout:analyze?api-version=2023-07-31`,
        file,
        { headers: { "Ocp-Apim-Subscription-Key": process.env.AZURE_KEY, "Content-Type": "application/pdf" } }
    );

    const pollUrl = response.headers["operation-location"];
    let result;
    while (true) {
        const poll = await axios.get(pollUrl, { headers: { "Ocp-Apim-Subscription-Key": process.env.AZURE_KEY } });
        if (poll.data.status === "succeeded") { result = poll.data; break; }
        if (poll.data.status === "failed") throw new Error("Azure OCR Failure");
        await new Promise(r => setTimeout(r, 2000));
    }
    return result.analyzeResult.pages.map(page => ({ page: page.pageNumber, text: page.lines.map(l => l.content).join("\n") }));
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

async function processEntry(entry) {
    const safeName = entry.file_name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const pdfPath = path.join(INPUT_DIR, `${safeName}.pdf`);
    const outputPath = path.join(OUTPUT_DIR, `${safeName}.html`);

    if (fs.existsSync(outputPath)) return;

    try {
        if (!fs.existsSync(pdfPath)) {
            const res = await axios({ url: entry.pdf_link, method: 'GET', responseType: 'stream' });
            res.data.pipe(fs.createWriteStream(pdfPath));
            await new Promise((resolve) => res.data.on('end', resolve));
        }

        let pages;
        const forceOCR = entry.manual_ocr === true || entry.manual_ocr === "true";
        
        if (forceOCR) {
            pages = await extractAzure(pdfPath);
        } else {
            pages = await extractPdfParse(pdfPath);
            if (pages.filter(p => p.text.trim().length >= MIN_CHARS_PER_PAGE).length / pages.length < 0.5) {
                pages = await extractAzure(pdfPath);
            }
        }

        const bodyContent = pages.map(p => {
            const engine = new DocumentProcessor(p.text);
            return `<section class="page" data-page="${p.page}">\n${engine.process()}</section>`;
        }).join("\n");

        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${he.encode(entry.file_name)}</title>
    <style>
        body { font-family: sans-serif; line-height: 1.6; max-width: 800px; margin: 40px auto; padding: 20px; color: #333; }
        .page { margin-bottom: 40px; border-bottom: 1px solid #eee; padding-bottom: 20px; }
        h1 { color: #000; }
        h2 { color: #444; margin-top: 1.5em; }
        p { margin: 1em 0; }
        ul { margin: 1em 0; padding-left: 2em; }
        li { margin: 0.5em 0; }
    </style>
</head>
<body>
    <header>
        <p><small>Source: <a href="${entry.pdf_link}">${entry.pdf_link}</a></small></p>
    </header>
    ${bodyContent}
</body>
</html>`;

        fs.writeFileSync(outputPath, html);
        console.log(`[DONE] ${entry.file_name}`);
    } catch (err) {
        console.error(`[ERR] ${entry.file_name}: ${err.message}`);
    }
}

async function runQueue(items, limit, worker) {
    const queue = [...items];
    const pool = Array.from({ length: limit }, async () => {
        while (queue.length > 0) {
            const item = queue.shift();
            if (item) await worker(item);
        }
    });
    await Promise.all(pool);
}

const config = JSON.parse(fs.readFileSync(DATA_JSON, "utf8"));
runQueue(config.pdf_links, CONCURRENCY, processEntry);
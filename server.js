const express = require("express");
const multer = require("multer");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs").promises;
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
} = require("docx");

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * ----------------------------
 * Config
 * ----------------------------
 */
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
const MAX_TOKENS = 8000;

// Character-based chunking for extracted PDF text (NOT tokens)
const PDF_TEXT_CHUNK_CHARS = 12000;
const PDF_TEXT_CHUNK_OVERLAP = 600;

// If combined extracted PDF text is larger than this, we do multi-pass (chunk notes -> final breakdown)
const MULTIPASS_THRESHOLD_CHARS = 40000;

// Multer: number of files
const MAX_FILES = 10;

// Visual fallback for PDFs that are basically image-only / scanned.
// We ONLY render pages when the PDF has very little extractable text.
// (These thresholds are conservative; tweak later with real-world samples.)
const VISUAL_FALLBACK_MIN_TEXT_CHARS = 1500; // if total extracted text < this, treat as image-heavy
const VISUAL_FALLBACK_MAX_CHARS_PER_PAGE = 120; // OR if text density is very low

// How many rendered pages max (keep small to avoid huge payloads)
const VISUAL_RENDER_MAX_PAGES = 6;

// Render settings (JPEG keeps payload smaller than PNG)
const VISUAL_RENDER_DPI = 150;
const VISUAL_RENDER_JPEG_QUALITY = 70;

// Express payload limits (affects revision payloads etc.)
app.use(express.json({ limit: "150mb" }));
app.use(express.urlencoded({ limit: "150mb", extended: true }));

/**
 * ----------------------------
 * Static frontend
 * ----------------------------
 */
app.use(express.static(path.join(__dirname)));

app.get("/styles.css", (req, res) => {
  res.sendFile(path.join(__dirname, "styles.css"));
});

app.get("/app.js", (req, res) => {
  res.sendFile(path.join(__dirname, "app.js"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/**
 * ----------------------------
 * Multer storage
 * ----------------------------
 */
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(__dirname, "uploads");
    await fs.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

// NOTE: We’re not setting a strict fileSize limit here yet.
// If you want one later, we can set multer limits and then add a “friendly error response”.
const upload = multer({ storage });

/**
 * ----------------------------
 * Anthropic client
 * ----------------------------
 */
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `You are a professional production breakdown specialist. Your job is to analyze film/video production briefs, scripts, and related documents to create detailed production breakdowns.

CRITICAL RULES:
1. ONLY state facts explicitly mentioned in the provided documents
2. Clearly mark any assumptions as "RECOMMENDED" or "ASSUMED"
3. NEVER mix up details from different projects
4. Read scripts carefully for hidden requirements (stunts, special equipment, etc.)
5. Format crew as "Department 1x" unless specific numbers are stated

BREAKDOWN STRUCTURE:
- SHOOT DAYS
- CREW (Travel CONFIRMED, Travel RECOMMENDED, Technical Crew)
- EQUIPMENT
- LOCATIONS
- ART/PROPS
- TRANSPORT
- TALENTS (extracted from script)
- USAGE (if mentioned)
- SPECIAL NOTES & QUESTIONS
- MISSING/TBD INFORMATION

Always separate CONFIRMED facts from RECOMMENDED assumptions.`;

/**
 * ----------------------------
 * pdf-parse (Node 24 + pdf-parse@2.x)
 * Use dynamic import and cache the resolved adapter function.
 * ----------------------------
 */
let _pdfParseAdapter = null;

async function getPdfParseAdapter() {
  if (_pdfParseAdapter) return _pdfParseAdapter;

  const mod = await import("pdf-parse");

  // Most common modern ESM shape: mod.default is a function
  if (typeof mod?.default === "function") {
    _pdfParseAdapter = async (buffer) => {
      const parsed = await mod.default(buffer);
      return {
        text: (parsed?.text || "").trim(),
        numpages: parsed?.numpages ?? null,
      };
    };
    return _pdfParseAdapter;
  }

  // Some builds may export a function directly (rare with dynamic import, but keep safe)
  if (typeof mod === "function") {
    _pdfParseAdapter = async (buffer) => {
      const parsed = await mod(buffer);
      return {
        text: (parsed?.text || "").trim(),
        numpages: parsed?.numpages ?? null,
      };
    };
    return _pdfParseAdapter;
  }

  // Your observed shape: module exports a PDFParse class
  if (typeof mod?.PDFParse === "function") {
    _pdfParseAdapter = async (buffer) => {
      const parser = new mod.PDFParse(new Uint8Array(buffer));

      const textRes = await parser.getText();
      const text = (textRes?.text || "").trim();

      const info = await parser.getInfo({ parsePageInfo: true });

      const numpages =
        (typeof info?.total === "number" && info.total) ||
        (Array.isArray(info?.pages) && info.pages.length) ||
        (typeof info?.pages === "number" && info.pages) ||
        null;

      return { text, numpages };
    };
    return _pdfParseAdapter;
  }

  const keys = mod ? Object.keys(mod) : [];
  throw new Error(
    `Unsupported pdf-parse module shape. import("pdf-parse") keys: ${keys.join(", ")}`
  );
}

/**
 * ----------------------------
 * Helpers
 * ----------------------------
 */
function getMediaType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const types = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".txt": "text/plain",
    ".doc": "application/msword",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  return types[ext] || "application/octet-stream";
}

async function fileToBase64(filepath) {
  const buffer = await fs.readFile(filepath);
  return buffer.toString("base64");
}

function chunkText(text, chunkSize, overlap) {
  const clean = (text || "").replace(/\r\n/g, "\n");
  if (!clean.trim()) return [];

  const chunks = [];
  let start = 0;

  while (start < clean.length) {
    const end = Math.min(start + chunkSize, clean.length);
    chunks.push(clean.slice(start, end));
    if (end >= clean.length) break;
    start = Math.max(0, end - overlap);
  }

  return chunks;
}

async function extractPdfText(filePath) {
  const buffer = await fs.readFile(filePath);
  const parse = await getPdfParseAdapter();
  return await parse(buffer);
}

/**
 * Render a single PDF page to a JPEG image.
 * We prefer JPEG vs PNG to keep payload sizes manageable.
 *
 * IMPORTANT:
 * - Requires poppler (pdftoppm) installed on the machine.
 */
async function renderPdfPageToJpeg(pdfPath, pageNumber, outputDir) {
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const safeBase = path.basename(pdfPath).replace(/[^a-zA-Z0-9-_]/g, "_");
  const outputPrefix = path.join(
    outputDir,
    `${safeBase}-${nonce}-page-${pageNumber}`
  );

  await execFileAsync("pdftoppm", [
    "-f",
    String(pageNumber),
    "-l",
    String(pageNumber),
    "-jpeg",
    "-jpegopt",
    `quality=${VISUAL_RENDER_JPEG_QUALITY}`,
    "-r",
    String(VISUAL_RENDER_DPI),
    pdfPath,
    outputPrefix,
  ]);

  // pdftoppm naming varies; scan the directory for the output
  const files = await fs.readdir(outputDir);
  const baseName = path.basename(outputPrefix);

  const candidates = files
    .filter((name) => {
      const lower = name.toLowerCase();
      return (
        name.startsWith(baseName) &&
        (lower.endsWith(".jpg") || lower.endsWith(".jpeg"))
      );
    })
    .sort();

  if (!candidates.length) {
    throw new Error(`pdftoppm produced no JPEG output for prefix: ${outputPrefix}`);
  }

  return path.join(outputDir, candidates[0]);
}

async function isPdftoppmAvailable() {
  try {
    await execFileAsync("pdftoppm", ["-h"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build Claude "content" array:
 * - Images: sent as image base64 blocks
 * - PDFs: extracted text chunked into multiple text blocks with clear markers
 * - PDFs with very little extractable text: ALSO render a small set of pages to images and send to Claude
 *
 * Returns:
 *  {
 *    content: [...],
 *    pdfDiagnostics: [{ filename, numpages, textLength, chunkCount }]
 *    totalExtractedPdfChars: number
 *  }
 */
async function createContentWithFiles(files, message = null) {
  const content = [];
  const pdfDiagnostics = [];
  let totalExtractedPdfChars = 0;

  if (message) {
    content.push({ type: "text", text: message });
  }

  // Only check this once per request
  const canRenderPdfPages = await isPdftoppmAvailable();

  for (const file of files) {
    const mediaType = getMediaType(file.originalname || file.filename);

    // Normal image uploads (screenshots, etc.)
    if (mediaType.startsWith("image/")) {
      const base64Data = await fileToBase64(file.path);
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: base64Data,
        },
      });
      continue;
    }

    // PDFs
    if (mediaType === "application/pdf") {
      const { text, numpages } = await extractPdfText(file.path);
      const textChars = (text || "").length;

      totalExtractedPdfChars += textChars;

      const chunks = chunkText(text, PDF_TEXT_CHUNK_CHARS, PDF_TEXT_CHUNK_OVERLAP);
      const pages = numpages || 0;
      const charsPerPage = pages > 0 ? textChars / pages : 0;

      // Decide whether to switch on visual fallback (PDF-level).
      // We do NOT render pages for normal text PDFs, only when it looks image-only / scanned.
      const shouldRenderVisual =
        pages > 0 &&
        (textChars < VISUAL_FALLBACK_MIN_TEXT_CHARS ||
          charsPerPage < VISUAL_FALLBACK_MAX_CHARS_PER_PAGE);

      // If visual fallback is needed, render a small set of pages to images.
      if (shouldRenderVisual) {
        if (!canRenderPdfPages) {
          // If poppler isn't available, we can't do the visual fallback.
          // Still add a clear marker so Claude knows text extraction is likely missing.
          content.push({
            type: "text",
            text:
              `===== PDF (IMAGE-HEAVY) DETECTED: ${file.originalname || file.filename} =====\n` +
              `This PDF appears to have little/no extractable text (possibly scanned or image-based),\n` +
              `but server cannot render pages because 'pdftoppm' is not available.\n` +
              `Please treat any extracted text as incomplete.\n` +
              `===== END PDF NOTICE: ${file.originalname || file.filename} =====\n`,
          });
        } else {
          console.log(
            `Image-heavy PDF detected (${Math.round(charsPerPage)} chars/page, textChars=${textChars}). Rendering sampled pages...`
          );

          const samplePages = [1]; // always include cover when possible

          // Evenly spaced sampling across the PDF (good for scanned/image-only docs)
          const interval = Math.max(2, Math.floor(pages / 5));
          for (let p = 1 + interval; p <= pages; p += interval) {
            samplePages.push(p);
          }

          const uniquePages = [...new Set(samplePages)].filter(
            (p) => p >= 1 && p <= pages
          );
          const cappedPages = uniquePages.slice(0, VISUAL_RENDER_MAX_PAGES);

          const renderDir = path.join(__dirname, "uploads");

          content.push({
            type: "text",
            text: `===== VISUAL PAGES FROM PDF: ${file.originalname || file.filename} (sampled) =====`,
          });

          for (const pageNum of cappedPages) {
            try {
              const imagePath = await renderPdfPageToJpeg(
                file.path,
                pageNum,
                renderDir
              );
              const base64Data = await fileToBase64(imagePath);

              content.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: base64Data,
                },
              });

              await fs.unlink(imagePath).catch(() => {});
            } catch (err) {
              console.error(
                `Failed rendering PDF page ${pageNum} for ${file.originalname || file.filename}:`,
                err
              );
            }
          }

          content.push({
            type: "text",
            text: `===== END VISUAL PAGES FROM PDF: ${file.originalname || file.filename} =====`,
          });
        }
      }

      // Diagnostics
      pdfDiagnostics.push({
        filename: file.originalname || file.filename,
        numpages,
        textLength: textChars,
        chunkCount: chunks.length,
      });

      // Add text chunks (even for image-heavy PDFs, include whatever we extracted)
      if (chunks.length === 0) {
        content.push({
          type: "text",
          text:
            `===== PDF: ${file.originalname || file.filename} =====\n` +
            `[No extractable text found. This PDF may be image-only / scanned / mostly visual.]\n` +
            `===== END PDF: ${file.originalname || file.filename} =====\n`,
        });
      } else {
        const total = chunks.length;
        for (let i = 0; i < total; i++) {
          content.push({
            type: "text",
            text:
              `===== PDF: ${file.originalname || file.filename} | CHUNK ${i + 1}/${total} =====\n` +
              chunks[i] +
              `\n===== END PDF: ${file.originalname || file.filename} | CHUNK ${
                i + 1
              }/${total} =====\n`,
          });
        }
      }

      continue;
    }

    // Other file types currently ignored (consistent with your current tool behavior)
  }

  return { content, pdfDiagnostics, totalExtractedPdfChars };
}

/**
 * When PDFs are huge, do multi-pass:
 * 1) For each PDF chunk block, ask Claude to extract structured "production notes" only (compact).
 * 2) Combine notes + images and ask Claude for final breakdown.
 */
async function runMultiPassBreakdown({ originalContent }) {
  const imageBlocks = originalContent.filter((b) => b.type === "image");
  const textBlocks = originalContent.filter((b) => b.type === "text");

  const notes = [];

  for (let i = 0; i < textBlocks.length; i++) {
    const block = textBlocks[i];

    const isGenericInstruction =
      typeof block.text === "string" &&
      block.text.startsWith("Please analyze these production brief documents");

    if (isGenericInstruction) continue;

    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2500,
      system:
        `You are extracting production-relevant facts from one chunk of source material.\n` +
        `STRICT RULES:\n` +
        `- ONLY include facts explicitly stated.\n` +
        `- If uncertain, label as RECOMMENDED or QUESTION.\n` +
        `OUTPUT FORMAT:\n` +
        `Return compact bullet notes under these headings:\n` +
        `SHOOT DAYS | CREW | EQUIPMENT | LOCATIONS | ART/PROPS | TRANSPORT | TALENTS | USAGE | SPECIAL NOTES & QUESTIONS | MISSING/TBD\n`,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `Extract production notes from this chunk (${i + 1}/${textBlocks.length}).\n\n` +
                block.text,
            },
          ],
        },
      ],
    });

    notes.push(msg.content?.[0]?.text || "");
  }

  const finalUserContent = [
    {
      type: "text",
      text:
        "You will now produce the final production breakdown. Use the notes below as the only factual source. " +
        "If images are attached, use them only to confirm visible details and call out any uncertainties as QUESTIONS.",
    },
    ...imageBlocks,
    {
      type: "text",
      text:
        `\n\n===== EXTRACTED NOTES (MULTI-PASS) =====\n` +
        notes.join("\n\n---\n\n") +
        `\n===== END EXTRACTED NOTES =====\n`,
    },
  ];

  const finalMsg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: finalUserContent }],
  });

  return finalMsg.content?.[0]?.text || "";
}

/**
 * ----------------------------
 * API: Generate breakdown
 * ----------------------------
 */
app.post(
  "/api/generate-breakdown",
  upload.array("files", MAX_FILES),
  async (req, res) => {
    const files = req.files || [];
    const cleanupPaths = files.map((f) => f.path);

    try {
      console.log("Uploaded files:");
      for (const f of files) {
        console.log(
          `- ${f.originalname} (${(f.size / (1024 * 1024)).toFixed(2)} MB)`
        );
      }

      if (files.length === 0) {
        return res.status(400).json({ error: "No files uploaded" });
      }

      if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(500).json({
          error:
            "Server is missing ANTHROPIC_API_KEY environment variable. Set it and restart the server.",
        });
      }

      const { content, pdfDiagnostics, totalExtractedPdfChars } =
        await createContentWithFiles(
          files,
          "Please analyze these production brief documents and create a detailed production breakdown following the format and rules in your system prompt."
        );

      if (pdfDiagnostics.length) {
        console.log("PDF extraction diagnostics:");
        for (const d of pdfDiagnostics) {
          const pages = d.numpages ?? 0;
          const density = pages > 0 ? Math.round(d.textLength / pages) : 0;

          console.log(
            `- ${d.filename}: pages=${d.numpages ?? "?"}, textChars=${
              d.textLength
            }, charsPerPage=${density}, chunks=${d.chunkCount}`
          );
        }
      }

      let breakdown = "";

      if (totalExtractedPdfChars > MULTIPASS_THRESHOLD_CHARS) {
        console.log(
          `Large extracted PDF text (${totalExtractedPdfChars} chars). Using multi-pass chunk->notes->final breakdown.`
        );
        breakdown = await runMultiPassBreakdown({ originalContent: content });
      } else {
        const message = await anthropic.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content }],
        });

        breakdown = message.content?.[0]?.text || "";
      }

      const conversationHistory = [
        { role: "user", content },
        { role: "assistant", content: [{ type: "text", text: breakdown }] },
      ];

      return res.json({ breakdown, conversationHistory });
    } catch (error) {
      console.error("Error generating breakdown:", error);
      return res.status(500).json({ error: "Failed to generate breakdown" });
    } finally {
      for (const p of cleanupPaths) {
        await fs.unlink(p).catch(() => {});
      }
    }
  }
);

/**
 * ----------------------------
 * API: Revise breakdown
 * ----------------------------
 */
app.post("/api/revise-breakdown", async (req, res) => {
  try {
    const { revisionRequest, currentBreakdown, conversationHistory } = req.body;

    if (!revisionRequest || !currentBreakdown) {
      return res.status(400).json({ error: "Missing required data" });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({
        error:
          "Server is missing ANTHROPIC_API_KEY environment variable. Set it and restart the server.",
      });
    }

    const messages = [
      ...(conversationHistory || []),
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Please revise the breakdown based on this feedback: ${revisionRequest}\n\n` +
              `Current breakdown:\n${currentBreakdown}`,
          },
        ],
      },
    ];

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages,
    });

    const revisedBreakdown = message.content?.[0]?.text || "";

    const updatedHistory = [
      ...messages,
      { role: "assistant", content: [{ type: "text", text: revisedBreakdown }] },
    ];

    return res.json({
      breakdown: revisedBreakdown,
      conversationHistory: updatedHistory,
    });
  } catch (error) {
    console.error("Error revising breakdown:", error);
    return res.status(500).json({ error: "Failed to revise breakdown" });
  }
});

/**
 * ----------------------------
 * API: Download as Word doc
 * ----------------------------
 */
app.post("/api/download-docx", async (req, res) => {
  try {
    const { breakdown } = req.body;

    if (!breakdown) {
      return res.status(400).json({ error: "No breakdown provided" });
    }

    const sections = breakdown.split("\n\n");
    const paragraphs = [];

    sections.forEach((section) => {
      if (section.trim()) {
        const lines = section.split("\n");
        lines.forEach((line) => {
          if (line.trim()) {
            const isHeader =
              /^[A-Z\s]+:?$/.test(line.trim()) || line.trim().endsWith(":");

            if (isHeader) {
              paragraphs.push(
                new Paragraph({
                  children: [
                    new TextRun({
                      text: line.trim(),
                      bold: true,
                      size: 28,
                    }),
                  ],
                  spacing: { before: 240, after: 120 },
                })
              );
            } else {
              paragraphs.push(
                new Paragraph({
                  children: [new TextRun(line)],
                  spacing: { after: 100 },
                })
              );
            }
          }
        });

        paragraphs.push(new Paragraph({ text: "" }));
      }
    });

    const doc = new Document({
      sections: [
        {
          properties: {
            page: {
              size: { width: 12240, height: 15840 }, // US Letter
              margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
            },
          },
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text: "PRODUCTION BREAKDOWN",
                  bold: true,
                  size: 36,
                }),
              ],
              heading: HeadingLevel.HEADING_1,
              alignment: AlignmentType.CENTER,
              spacing: { after: 400 },
            }),
            ...paragraphs,
          ],
        },
      ],
    });

    const buffer = await Packer.toBuffer(doc);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=production-breakdown.docx"
    );
    return res.send(buffer);
  } catch (error) {
    console.error("Error generating Word doc:", error);
    return res.status(500).json({ error: "Failed to generate Word document" });
  }
});

/**
 * ----------------------------
 * Start server
 * ----------------------------
 */
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Production Breakdown Tool running on http://localhost:${PORT}`);
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log(
        "WARNING: ANTHROPIC_API_KEY is NOT set (breakdown calls will fail)."
      );
    } else {
      console.log("ANTHROPIC_API_KEY detected.");
    }
    console.log(`Using model: ${MODEL}`);
  });
}

module.exports = app;
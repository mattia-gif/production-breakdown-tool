const express = require('express');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs').promises;
const path = require('path');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        await fs.mkdir(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});

const upload = multer({ storage });

// Middleware
app.use(express.json({ limit: "150mb" }));
app.use(express.urlencoded({ limit: "150mb", extended: true }));

// Serve static frontend files (index.html, styles.css, app.js)
app.use(express.static(path.join(__dirname)));

app.get("/styles.css", (req, res) => {
  res.sendFile(path.join(__dirname, "styles.css"));
});

app.get("/app.js", (req, res) => {
  res.sendFile(path.join(__dirname, "app.js"));
});

// Homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Initialize Anthropic client
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
});

// System prompt for breakdown generation
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

// Helper: Convert files to base64 for Claude
async function fileToBase64(filepath) {
    const buffer = await fs.readFile(filepath);
    return buffer.toString('base64');
}

// Helper: Get media type from filename
function getMediaType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const types = {
        '.pdf': 'application/pdf',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.txt': 'text/plain',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    };
    return types[ext] || 'application/octet-stream';
}

// Helper: Create conversation content with files
async function createContentWithFiles(files, message = null) {
    const content = [];
    
    // Add user message if provided
    if (message) {
        content.push({
            type: 'text',
            text: message
        });
    }
    
    // Add uploaded files
    for (const file of files) {
        const mediaType = getMediaType(file.originalname || file.filename);
        
        if (mediaType.startsWith('image/')) {
            const base64Data = await fileToBase64(file.path);
            content.push({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: mediaType,
                    data: base64Data
                }
            });
        } else if (mediaType === 'application/pdf') {
            const base64Data = await fileToBase64(file.path);
            content.push({
                type: 'document',
                source: {
                    type: 'base64',
                    media_type: mediaType,
                    data: base64Data
                }
            });
        }
    }
    
    return content;
}

// API: Generate breakdown
app.post('/api/generate-breakdown', upload.array('files', 10), async (req, res) => {
    try {
        const files = req.files;
        
        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        // Create content with all uploaded files
        const content = await createContentWithFiles(
            files,
            'Please analyze these production brief documents and create a detailed production breakdown following the format and rules in your system prompt.'
        );

        // Call Claude API
        const message = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 8000,
            system: SYSTEM_PROMPT,
            messages: [{
                role: 'user',
                content: content
            }]
        });

        const breakdown = message.content[0].text;

        // Store conversation history for revisions
        const conversationHistory = [
            { role: 'user', content },
            { role: 'assistant', content: [{ type: 'text', text: breakdown }] }
        ];

        // Clean up uploaded files
        for (const file of files) {
            await fs.unlink(file.path).catch(() => {});
        }

        res.json({ 
            breakdown,
            conversationHistory
        });

    } catch (error) {
        console.error('Error generating breakdown:', error);
        res.status(500).json({ error: 'Failed to generate breakdown' });
    }
});

// API: Revise breakdown
app.post('/api/revise-breakdown', async (req, res) => {
    try {
        const { revisionRequest, currentBreakdown, conversationHistory } = req.body;

        if (!revisionRequest || !currentBreakdown) {
            return res.status(400).json({ error: 'Missing required data' });
        }

        // Add revision request to conversation
        const messages = [
            ...conversationHistory,
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: `Please revise the breakdown based on this feedback: ${revisionRequest}\n\nCurrent breakdown:\n${currentBreakdown}`
                    }
                ]
            }
        ];

        // Call Claude API with conversation history
        const message = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 8000,
            system: SYSTEM_PROMPT,
            messages: messages
        });

        const revisedBreakdown = message.content[0].text;

        // Update conversation history
        const updatedHistory = [
            ...messages,
            { role: 'assistant', content: [{ type: 'text', text: revisedBreakdown }] }
        ];

        res.json({
            breakdown: revisedBreakdown,
            conversationHistory: updatedHistory
        });

    } catch (error) {
        console.error('Error revising breakdown:', error);
        res.status(500).json({ error: 'Failed to revise breakdown' });
    }
});

// API: Download as Word doc
app.post('/api/download-docx', async (req, res) => {
    try {
        const { breakdown } = req.body;

        if (!breakdown) {
            return res.status(400).json({ error: 'No breakdown provided' });
        }

        // Parse breakdown text into sections
        const sections = breakdown.split('\n\n');
        const paragraphs = [];

        sections.forEach(section => {
            if (section.trim()) {
                const lines = section.split('\n');
                lines.forEach((line, index) => {
                    if (line.trim()) {
                        // Check if line is a header (all caps or ends with :)
                        const isHeader = /^[A-Z\s]+:?$/.test(line.trim()) || line.endsWith(':');
                        
                        if (isHeader) {
                            paragraphs.push(
                                new Paragraph({
                                    children: [
                                        new TextRun({
                                            text: line.trim(),
                                            bold: true,
                                            size: 28
                                        })
                                    ],
                                    spacing: { before: 240, after: 120 }
                                })
                            );
                        } else {
                            paragraphs.push(
                                new Paragraph({
                                    children: [new TextRun(line)],
                                    spacing: { after: 100 }
                                })
                            );
                        }
                    }
                });
                
                // Add space between sections
                paragraphs.push(new Paragraph({ text: '' }));
            }
        });

        // Create document
        const doc = new Document({
            sections: [{
                properties: {
                    page: {
                        size: {
                            width: 12240,  // US Letter width
                            height: 15840  // US Letter height
                        },
                        margin: {
                            top: 1440,
                            right: 1440,
                            bottom: 1440,
                            left: 1440
                        }
                    }
                },
                children: [
                    new Paragraph({
                        children: [
                            new TextRun({
                                text: 'PRODUCTION BREAKDOWN',
                                bold: true,
                                size: 36
                            })
                        ],
                        heading: HeadingLevel.HEADING_1,
                        alignment: AlignmentType.CENTER,
                        spacing: { after: 400 }
                    }),
                    ...paragraphs
                ]
            }]
        });

        // Generate buffer
        const buffer = await Packer.toBuffer(doc);

        // Send as download
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', 'attachment; filename=production-breakdown.docx');
        res.send(buffer);

    } catch (error) {
        console.error('Error generating Word doc:', error);
        res.status(500).json({ error: 'Failed to generate Word document' });
    }
});

// Start server only when running locally (not on Vercel)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Production Breakdown Tool running on http://localhost:${PORT}`);
    console.log("Make sure to set ANTHROPIC_API_KEY environment variable");
  });
}

module.exports = app;

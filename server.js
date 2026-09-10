const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const GATE_PASSWORD = process.env.GATE_PASSWORD || 'admin123';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || '';

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, message: 'Too many login attempts. Try again later.' }
});

app.post('/api/auth', loginLimiter, (req, res) => {
    const { password } = req.body;
    if (password === GATE_PASSWORD) {
        return res.json({ success: true, token: Buffer.from(GATE_PASSWORD).toString('base64') });
    }
    return res.status(401).json({ success: false, message: 'Incorrect password' });
});

function parseSpintax(text) {
    if (!text) return '';
    return text.replace(/\{([^{}]+)\}/g, (match, choices) => {
        const options = choices.split('|');
        return options[Math.floor(Math.random() * options.length)].trim();
    });
}

function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<br\s*[\/]?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<[^>]*>?/gm, '')
        .replace(/&nbsp;/gi, ' ')
        .trim();
}

async function verifyTurnstile(token) {
    if (!TURNSTILE_SECRET || TURNSTILE_SECRET.startsWith('1x00000000')) return true;
    try {
        const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `secret=${encodeURIComponent(TURNSTILE_SECRET)}&response=${encodeURIComponent(token)}`
        });
        const data = await response.json();
        return data.success;
    } catch (e) {
        return false;
    }
}

// CLEAN INBOX DISPATCH (NO REF ID - FAST BATCHING)
app.post('/api/send-stream', async (req, res) => {
    const { senderName, email, appPassword, subject, body, recipients, cfToken, authToken } = req.body;

    if (authToken !== Buffer.from(GATE_PASSWORD).toString('base64')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const isHuman = await verifyTurnstile(cfToken);
    if (!isHuman) {
        return res.status(400).json({ error: 'Captcha validation failed' });
    }

    if (!email || !appPassword || !recipients || !Array.isArray(recipients) || recipients.length === 0) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendSSE = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Nodemailer SMTP Pool setup
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        pool: true,
        maxConnections: 8,
        maxMessages: 200,
        rateDelta: 1000,
        rateLimit: 8,
        auth: {
            user: email.trim().toLowerCase(),
            pass: appPassword.replace(/\s+/g, '')
        }
    });

    try {
        await transporter.verify();
    } catch (error) {
        sendSSE({ type: 'fatal_error', message: 'SMTP Auth Failed. Check Gmail & App Password.' });
        return res.end();
    }

    const total = recipients.length;
    let sentCount = 0;
    let failedCount = 0;

    sendSSE({ type: 'start', total });

    // 8 emails per batch (3 Batches = 24 emails in ~10 seconds)
    const BATCH_SIZE = 8;

    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
        const batch = recipients.slice(i, i + BATCH_SIZE);

        const batchPromises = batch.map(async (recipientItem) => {
            let targetEmail = '';
            let targetName = '';

            if (typeof recipientItem === 'object' && recipientItem !== null) {
                targetEmail = recipientItem.email || recipientItem.recipient || '';
                targetName = recipientItem.name || '';
            } else {
                targetEmail = String(recipientItem).trim();
            }

            // Pure dynamic content without any extra Ref IDs
            const dynamicSubject = parseSpintax(subject);
            const dynamicBody = parseSpintax(body);
            const plainText = stripHtml(dynamicBody);

            const mailOptions = {
                from: senderName ? `"${senderName}" <${email}>` : email,
                to: targetName ? `"${targetName}" <${targetEmail}>` : targetEmail,
                replyTo: email,
                subject: dynamicSubject,
                text: plainText,
                html: dynamicBody,
                headers: {
                    'X-Priority': '3',
                    'X-MSMail-Priority': 'Normal'
                }
            };

            try {
                const info = await transporter.sendMail(mailOptions);
                return { recipient: targetEmail, success: true, messageId: info.messageId };
            } catch (err) {
                return { recipient: targetEmail, success: false, error: err.message };
            }
        });

        const results = await Promise.all(batchPromises);

        results.forEach((resResult) => {
            if (resResult.success) {
                sentCount++;
                sendSSE({ type: 'progress', status: 'sent', recipient: resResult.recipient, sentCount, failedCount });
            } else {
                failedCount++;
                sendSSE({ type: 'progress', status: 'failed', recipient: resResult.recipient, error: resResult.error, sentCount, failedCount });
            }
        });

        if (i + BATCH_SIZE < recipients.length) {
            await new Promise((resolve) => setTimeout(resolve, 1800));
        }
    }

    transporter.close();
    sendSSE({ type: 'complete', sentCount, failedCount, total });
    res.end();
});

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
    });
}

module.exports = app;

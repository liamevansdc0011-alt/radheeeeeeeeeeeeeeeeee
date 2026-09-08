import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '1x0000000000000000000000000000000AA';

const globalSession = { stopRequested: false };
const poolMap = new Map();

// Helper Delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Express Setup
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/* ==========================================================================
   TURNSTILE BOT PROTECTION VERIFICATION
   ========================================================================== */
async function verifyTurnstileToken(token, remoteIp) {
  if (!token || TURNSTILE_SECRET_KEY.startsWith('1x0000000000000000000000000000000AA')) {
    return true;
  }

  try {
    const formData = new URLSearchParams();
    formData.append('secret', TURNSTILE_SECRET_KEY);
    formData.append('response', token);
    if (remoteIp) formData.append('remoteip', remoteIp);

    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    });
    const outcome = await result.json();
    return outcome.success === true;
  } catch (error) {
    return false;
  }
}

/* ==========================================================================
   OPTIMIZED GMAIL SSL TRANSPORTER POOL (Port 465 is more stable for Gmail)
   ========================================================================== */
function getPort465Transporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cleanPass = appPassword.replace(/\s+/g, '').trim();
  const key = `port465_${cleanEmail}_${cleanPass}`;

  if (poolMap.size > 50) {
    poolMap.clear();
  }

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: cleanEmail,
        pass: cleanPass
      },
      pool: true,
      maxConnections: 2, // Low connections prevent Gmail flagging
      maxMessages: 100,
      socketTimeout: 30000,
      connectionTimeout: 30000
    });
    poolMap.set(key, transporter);
  }
  return poolMap.get(key);
}

/* ==========================================================================
   RECIPIENT & SPINTAX HELPERS
   ========================================================================== */
function parseRecipientData(input) {
  let email = '';
  let rawName = '';

  if (typeof input === 'object' && input !== null) {
    email = (input.email || input.recipient || '').trim();
    rawName = (input.name || input.fullName || input.first_name || '').trim();
  } else if (typeof input === 'string') {
    const str = input.trim();
    const angleMatch = str.match(/^(?:"?([^"]*)"?\s)?<([^>]+)>$/);
    if (angleMatch) {
      rawName = angleMatch[1] ? angleMatch[1].trim() : '';
      email = angleMatch[2].trim();
    } else if (str.includes(',')) {
      const parts = str.split(',');
      if (parts[0].includes('@')) {
        email = parts[0].trim();
        rawName = parts[1].trim();
      } else {
        rawName = parts[0].trim();
        email = parts[1].trim();
      }
    } else {
      email = str;
    }
  }

  if (!rawName && email.includes('@')) {
    const prefix = email.split('@')[0];
    rawName = prefix.replace(/[0-9_.-]/g, ' ').trim();
  }

  const formattedName = rawName
    ? rawName.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
    : '';

  const firstName = formattedName ? formattedName.split(' ')[0] : '';
  const domain = email.includes('@') ? email.split('@')[1] : '';

  return {
    email: email.toLowerCase(),
    name: formattedName,
    firstName: firstName,
    domain: domain
  };
}

function parseSpintax(text) {
  if (!text) return '';
  let spun = String(text);
  const regex = /\{([^{}]+)\}/s;
  let iterations = 0;

  while (regex.test(spun) && iterations < 30) {
    spun = spun.replace(regex, (_, choices) => {
      if (!choices.includes('|')) return choices;
      const options = choices.split('|');
      const pick = options[Math.floor(Math.random() * options.length)];
      return pick ? pick.trim() : '';
    });
    iterations++;
  }
  return spun.replace(/[\{\}]/g, '').trim();
}

// Generate visible, clean, natural reference numbers for body customization
function generateNaturalRefCode() {
  const hexPart = crypto.randomBytes(3).toString('hex').toUpperCase();
  const numPart = Math.floor(1000 + Math.random() * 9000);
  return `${hexPart}-${numPart}`;
}

function personalizeContent(template, recipient) {
  if (!template) return '';
  let content = parseSpintax(template);

  const displayName = recipient.name || recipient.firstName || 'Customer';
  const displayFirstName = recipient.firstName || displayName;

  content = content.replace(/{Name}/gi, displayName);
  content = content.replace(/{FirstName}/gi, displayFirstName);
  content = content.replace(/{First_Name}/gi, displayFirstName);
  content = content.replace(/{Email}/gi, recipient.email);
  content = content.replace(/{Domain}/gi, recipient.domain);

  return content;
}

function createPlainTextFromHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

/* ==========================================================================
   API ROUTES
   ========================================================================== */
app.get('/', (req, res) => {
  const filePath1 = path.join(process.cwd(), 'public', 'index.html');
  const filePath2 = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(filePath1)) return res.sendFile(filePath1);
  if (fs.existsSync(filePath2)) return res.sendFile(filePath2);
  return res.status(200).send('<h1>Server Running Safely</h1>');
});

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) return res.json({ success: true, message: 'Authorized' });
  return res.status(401).json({ success: false, message: 'Unauthorized Password' });
});

app.post('/api/verify', async (req, res) => {
  const { email, appPassword, cfToken } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: 'Credentials required' });
  }

  if (cfToken) {
    const isHuman = await verifyTurnstileToken(cfToken, clientIp);
    if (!isHuman) {
      return res.status(403).json({ success: false, message: 'Security Verification Failed' });
    }
  }

  try {
    const transporter = getPort465Transporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: 'SMTP verified successfully' });
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: error.message || 'SMTP Auth Failed. Check 16-char App Password.'
    });
  }
});

/* ==========================================================================
   INBOX-OPTIMIZED SSE DISPATCH ROUTE (Batch 2 + Safe Natural Delay)
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients, cfToken } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Invalid Request Data' })}\n\n`);
    res.end();
    return;
  }

  if (cfToken) {
    const isHuman = await verifyTurnstileToken(cfToken, clientIp);
    if (!isHuman) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Turnstile Verification Failed' })}\n\n`);
      res.end();
      return;
    }
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || '').replace(/["\r\n]/g, '').trim();
  globalSession.stopRequested = false;

  const keepAlivePing = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 4000);

  const transporter = getPort465Transporter(email, appPassword);
  
  // High Inbox Batching Config: BATCH_SIZE 2 allows natural human-like delivery
  const BATCH_SIZE = 2;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    if (globalSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Stopped by User' })}\n\n`);
      break;
    }

    const currentBatch = recipients.slice(i, i + BATCH_SIZE);

    const sendPromises = currentBatch.map(async (rawRecipient, index) => {
      // 500ms delay per thread in batch to avoid concurrent connection locks
      await delay(index * 500);

      const recipient = parseRecipientData(rawRecipient);

      if (!recipient.email || !recipient.email.includes('@')) {
        return { success: false, recipient: recipient.email || '', error: 'Invalid Email' };
      }

      try {
        const personalizedSubject = personalizeContent(subject, recipient);
        const personalizedBody = personalizeContent(messageBody, recipient);
        const isHtml = /<[a-z][\s\S]*>/i.test(personalizedBody);

        // Natural, unique reference code appended at the bottom of the body
        const refCode = generateNaturalRefCode();
        const refFooterHtml = `<br><br><p style="color:#777;font-size:11px;margin-top:20px;">Ref-ID: #${refCode}</p>`;
        const refFooterText = `\n\nRef-ID: #${refCode}`;

        const innerContent = isHtml
          ? personalizedBody
          : personalizedBody.replace(/\n/g, '<br>');

        const formattedHtml = `<div dir="ltr">${innerContent}${refFooterHtml}</div>`;
        const plainTextFormatted = createPlainTextFromHtml(personalizedBody) + refFooterText;

        // Custom RFC-compliant Message-ID matching sender domain
        const domainPart = cleanEmail.split('@')[1] || 'gmail.com';
        const messageId = `<${crypto.randomBytes(16).toString('hex')}@${domainPart}>`;

        const mailOptions = {
          from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
          to: recipient.name ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
          replyTo: cleanEmail,
          messageId: messageId,
          date: new Date(),
          subject: personalizedSubject || 'Update',
          html: formattedHtml,
          text: plainTextFormatted
        };

        const info = await transporter.sendMail(mailOptions);
        return {
          success: true,
          recipient: recipient.email,
          name: recipient.name,
          ref: info.messageId || 'SENT'
        };

      } catch (err) {
        return { success: false, recipient: recipient.email, error: err.message };
      }
    });

    const batchResults = await Promise.allSettled(sendPromises);

    for (const resItem of batchResults) {
      if (resItem.status === 'fulfilled') {
        res.write(`data: ${JSON.stringify(resItem.value)}\n\n`);
      }
    }

    // Natural randomized delay of 2.5s to 4.5s between batches for Maximum Deliverability
    if (i + BATCH_SIZE < recipients.length) {
      const batchDelay = 2500 + Math.floor(Math.random() * 2000);
      await delay(batchDelay);
    }
  }

  clearInterval(keepAlivePing);
  res.write('data: [DONE]\n\n');
  res.end();
});

app.post('/api/stop', (req, res) => {
  globalSession.stopRequested = true;
  res.json({ success: true, message: 'Sending process stopped' });
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 Mailer server running safely on port ${PORT}`);
  });
}

export default app;

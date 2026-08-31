import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';
const globalSession = { stopRequested: false };

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(process.cwd(), 'public')));

// Organic Transport Engine (No Aggressive Pooling)
function createInboxOptimizedTransporter(user, pass) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // STARTTLS
    requireTLS: true,
    auth: { user: user.toLowerCase().trim(), pass: pass.replace(/\s+/g, '').trim() },
    tls: { rejectUnauthorized: true, ciphers: 'SSLv3' },
    maxConnections: 3,
    maxMessages: 100
  });
}

function parseRecipient(input) {
  let email = '', rawName = '';
  if (typeof input === 'object' && input !== null) {
    email = (input.email || input.recipient || '').trim();
    rawName = (input.name || input.fullName || '').trim();
  } else if (typeof input === 'string') {
    const match = input.trim().match(/^(?:"?([^"]*)"?\s)?<([^>]+)>$/);
    if (match) {
      rawName = match[1] ? match[1].trim() : '';
      email = match[2].trim();
    } else if (input.includes(',')) {
      const parts = input.split(',');
      email = parts[0].includes('@') ? parts[0].trim() : parts[1].trim();
      rawName = parts[0].includes('@') ? parts[1].trim() : parts[0].trim();
    } else {
      email = input.trim();
    }
  }

  if (!rawName && email.includes('@')) {
    rawName = email.split('@')[0].replace(/[0-9_.-]/g, ' ').trim();
  }

  const name = rawName ? rawName.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') : '';
  return {
    email: email.toLowerCase(),
    name: name,
    firstName: name ? name.split(' ')[0] : 'Friend',
    domain: email.includes('@') ? email.split('@')[1] : ''
  };
}

function processSpintax(text) {
  if (!text) return '';
  let str = String(text);
  const regex = /\{([^{}]+)\}/s;
  let count = 0;
  while (regex.test(str) && count < 30) {
    str = str.replace(regex, (_, choices) => {
      const opts = choices.split('|');
      return opts[Math.floor(Math.random() * opts.length)].trim();
    });
    count++;
  }
  return str.replace(/[\{\}]/g, '').trim();
}

function buildPersonalizedPayload(template, rec) {
  if (!template) return '';
  let res = processSpintax(template);
  res = res.replace(/{Name}/gi, rec.name || rec.firstName);
  res = res.replace(/{FirstName}/gi, rec.firstName);
  res = res.replace(/{Email}/gi, rec.email);
  res = res.replace(/{Domain}/gi, rec.domain);
  return res;
}

app.post('/api/auth', (req, res) => {
  if (req.body.password === SITE_PASSWORD) return res.json({ success: true, message: 'Authorized' });
  return res.status(401).json({ success: false, message: 'Unauthorized Password' });
});

app.post('/api/verify', async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) return res.status(400).json({ success: false, message: 'Credentials missing' });
  try {
    const t = createInboxOptimizedTransporter(email, appPassword);
    await t.verify();
    return res.json({ success: true, message: 'SMTP Verified Successfully' });
  } catch (err) {
    return res.status(401).json({ success: false, message: 'SMTP Auth Failed: Check 16-char App Password' });
  }
});

app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;
  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: 'Invalid Input Data' })}\n\n`);
    return res.end();
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || '').replace(/["\r\n]/g, '').trim();
  const domain = cleanEmail.split('@')[1] || 'gmail.com';
  globalSession.stopRequested = false;

  const transporter = createInboxOptimizedTransporter(email, appPassword);

  // Sequential Processing with Dynamic Human-like Micro Delays
  for (let i = 0; i < recipients.length; i++) {
    if (globalSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: 'Process Stopped by User' })}\n\n`);
      break;
    }

    const rec = parseRecipient(recipients[i]);
    if (!rec.email) continue;

    try {
      const pSubject = buildPersonalizedPayload(subject, rec);
      const pBody = buildPersonalizedPayload(messageBody, rec);
      const isHtml = /<[a-z][\s\S]*>/i.test(pBody);

      // Authentic Webmail Headers (Bypasses Bot Heuristics)
      const msgHex = crypto.randomBytes(6).toString('hex');
      const customMessageId = `<${Date.now()}.${msgHex}@${domain}>`;

      const mailOptions = {
        from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
        to: rec.name ? `"${rec.name}" <${rec.email}>` : rec.email,
        replyTo: cleanEmail,
        date: new Date(),
        subject: pSubject || 'Update',
        headers: {
          'Message-ID': customMessageId,
          'X-Mailer': 'GmailWebInterface/2.0',
          'X-Priority': '3',
          'MIME-Version': '1.0'
        }
      };

      if (isHtml) {
        mailOptions.html = `<div dir="ltr" style="font-family: Arial, sans-serif; font-size: 14px; color: #222;">${pBody}</div>`;
        mailOptions.text = pBody.replace(/<[^>]+>/g, '').trim();
      } else {
        mailOptions.text = pBody;
      }

      await transporter.sendMail(mailOptions);
      
      const resPayload = { success: true, recipient: rec.email, name: rec.name };
      io.emit('mail_sent', resPayload);
      res.write(`data: ${JSON.stringify(resPayload)}\n\n`);

      // 90ms Se Lekar Random 180ms Delay (Human Simulation)
      const dynamicJitter = Math.floor(90 + Math.random() * 90);
      await new Promise(r => setTimeout(r, dynamicJitter));

    } catch (err) {
      const errPayload = { success: false, recipient: rec.email, error: err.message };
      io.emit('mail_error', errPayload);
      res.write(`data: ${JSON.stringify(errPayload)}\n\n`);
    }
  }

  res.write('data: [DONE]\n\n');
  res.end();
});

app.post('/api/stop', (req, res) => {
  globalSession.stopRequested = true;
  res.json({ success: true, message: 'Execution Stopped' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`[Inbox Transport System Active on Port ${PORT}]`);
});

export default app;

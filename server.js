import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';

const globalSession = { stopRequested: false };
const poolMap = new Map();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ==========================================================================
   1. SECURE & HIGH-DELIVERABILITY SMTP TRANSPORTER
   ========================================================================== */
function getPort587Transporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const key = `port587_${cleanEmail}_${appPassword}`;

  if (!poolMap.has(key)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,         // Uses STARTTLS
      requireTLS: true,
      auth: {
        user: cleanEmail,
        pass: appPassword
      },
      pool: true,
      maxConnections: 3,     // Optimized pool for 1 sec speed
      maxMessages: 200,
      rateLimit: 1           // 1 message per second
    });

    poolMap.set(key, transporter);
  }

  return poolMap.get(key);
}

/* ==========================================================================
   2. ANTI-SPAM UTILITIES & HUMAN ENGINE
   ========================================================================== */

// Invisible Zero-Width Space Fingerprint Generator (Keeps body unique to filters, 100% hidden to client)
function generateInvisibleFingerprint() {
  const zwChars = ['\u200B', '\u200C', '\u200D', '\uFEFF'];
  let fingerprint = '';
  for (let i = 0; i < 8; i++) {
    fingerprint += zwChars[Math.floor(Math.random() * zwChars.length)];
  }
  return fingerprint;
}

// Natural Conversational P.S. Generator to boost Positive Replies
function getConversationalPS() {
  const options = [
    "P.S. Does this sound like something relevant to you right now?",
    "P.S. Feel free to reply directly to this email if you have any questions.",
    "P.S. Would you be open to a quick 2-minute chat on this?",
    "P.S. Let me know your thoughts whenever you get a moment.",
    "P.S. Happy to share more details if you're interested."
  ];
  return options[Math.floor(Math.random() * options.length)];
}

function parseRecipientData(input) {
  let email = "";
  let rawName = "";

  if (typeof input === 'object' && input !== null) {
    email = (input.email || input.recipient || "").trim();
    rawName = (input.name || input.fullName || input.first_name || "").trim();
  } else if (typeof input === 'string') {
    const str = input.trim();
    const angleMatch = str.match(/^(?:"?([^"]*)"?\s)?<([^>]+)>$/);
    if (angleMatch) {
      rawName = angleMatch[1] ? angleMatch[1].trim() : "";
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
    : "Valued Partner";

  const firstName = formattedName.split(' ')[0] || "there";
  const domain = email.includes('@') ? email.split('@')[1] : "";

  return {
    email: email.toLowerCase(),
    name: formattedName,
    firstName: firstName,
    domain: domain
  };
}

function parseSpintax(text) {
  if (!text) return "";
  let spun = text;
  const regex = /{([^{}]+)}/g;
  let iterations = 0;

  while (regex.test(spun) && iterations < 10) {
    spun = spun.replace(regex, (_, choices) => {
      if (!choices.includes('|')) return `{${choices}}`;
      const options = choices.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });
    iterations++;
  }
  return spun;
}

function personalizeContent(template, recipient) {
  if (!template) return "";
  let content = parseSpintax(template);

  const currentDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  content = content.replace(/{Name}/gi, recipient.name);
  content = content.replace(/{FirstName}/gi, recipient.firstName);
  content = content.replace(/{First_Name}/gi, recipient.firstName);
  content = content.replace(/{Email}/gi, recipient.email);
  content = content.replace(/{Domain}/gi, recipient.domain);
  content = content.replace(/{Date}/gi, currentDate);

  return content;
}

function createPlainTextFromHtml(html) {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

/* ==========================================================================
   3. API ROUTES
   ========================================================================== */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) {
    return res.json({ success: true, message: "Authorized" });
  }
  return res.status(401).json({ success: false, message: "Unauthorized Password" });
});

app.post("/api/verify", async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: "Credentials required" });
  }

  try {
    const transporter = getPort587Transporter(email, appPassword);
    await transporter.verify();
    return res.json({ success: true, message: "SMTP verified successfully" });
  } catch (error) {
    return res.status(401).json({ success: false, message: "SMTP Auth Failed. Verify App Password." });
  }
});

/* ==========================================================================
   4. STREAMING ENGINE (1 Second Delay + Zero-Width Anti-Spam + High Reply Rate)
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Invalid Request Data" })}\n\n`);
    res.end();
    return;
  }

  const cleanEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || "").replace(/"/g, "").trim();
  globalSession.stopRequested = false;

  const keepAlivePing = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 4000);

  const transporter = getPort587Transporter(email, appPassword);

  for (let i = 0; i < recipients.length; i++) {
    if (globalSession.stopRequested) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Stopped by User" })}\n\n`);
      break;
    }

    const recipient = parseRecipientData(recipients[i]);
    if (!recipient.email) continue;

    try {
      const personalizedSubject = personalizeContent(subject, recipient);
      let personalizedBody = personalizeContent(messageBody, recipient);
      const isHtml = /<[a-z][\s\S]*>/i.test(personalizedBody);

      // Unique natural element for response rate + invisible anti-spam hash
      const invisibleHash = generateInvisibleFingerprint();
      const psLine = getConversationalPS();
      const uniqueMsgId = `<${crypto.randomBytes(12).toString('hex')}@${cleanEmail.split('@')[1]}>`;

      const mailOptions = {
        from: cleanSenderName ? `"${cleanSenderName}" <${cleanEmail}>` : cleanEmail,
        to: recipient.name !== "Valued Partner" ? `"${recipient.name}" <${recipient.email}>` : recipient.email,
        replyTo: cleanEmail,
        subject: personalizedSubject,
        messageId: uniqueMsgId,
        headers: {
          'X-Mailer': 'Microsoft Outlook 16.0',
          'List-Unsubscribe': `<mailto:${cleanEmail}?subject=Unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
      };

      if (isHtml) {
        const bodyWithPsAndHash = `
          ${personalizedBody}
          <br><br>
          <p style="font-size: 13px; color: #444444; margin-top: 15px;">${psLine}</p>
          <span style="display:none !important; font-size:0px; line-height:0px;">${invisibleHash}</span>
        `;
        mailOptions.html = bodyWithPsAndHash;
        mailOptions.text = createPlainTextFromHtml(personalizedBody) + `\n\n${psLine}`;
      } else {
        mailOptions.text = personalizedBody + `\n\n${psLine}` + invisibleHash;
      }

      await transporter.sendMail(mailOptions);
      res.write(`data: ${JSON.stringify({ success: true, recipient: recipient.email, name: recipient.name })}\n\n`);

    } catch (err) {
      console.error(`Send Failure [${recipient.email}]:`, err.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient: recipient.email, error: err.message })}\n\n`);
    }

    // Exact 1-Second Speed Delay per mail
    if (i < recipients.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  clearInterval(keepAlivePing);
  res.write("data: [DONE]\n\n");
  res.end();
});

app.post('/api/stop', (req, res) => {
  globalSession.stopRequested = true;
  res.json({ success: true, message: "Sending process stopped" });
});

app.listen(PORT, () => {
  console.log(`Server running on Port ${PORT} [1-Sec High Inbox Engine Active]`);
});

export default app;

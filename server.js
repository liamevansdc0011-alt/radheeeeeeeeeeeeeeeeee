import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'admin123';

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

const activeSessions = {};
const transporterCache = new Map();

/* ==========================================================================
   1. POLYMORPHIC ANTI-FINGERPRINTING (ZERO-WIDTH NOISE INJECTOR)
   ========================================================================== */
function injectPolymorphicNoise(content) {
  if (!content) return "";
  const zeroWidthChars = ['\u200B', '\u200C', '\u200D', '\uFEFF'];
  
  return content.replace(/(<p[^>]*>|<div[^>]*>|<br\s*\/?>|\n)/gi, (match) => {
    const randomCount = Math.floor(Math.random() * 4) + 1;
    let noise = '';
    for (let i = 0; i < randomCount; i++) {
      noise += zeroWidthChars[Math.floor(Math.random() * zeroWidthChars.length)];
    }
    return match + noise;
  });
}

/* ==========================================================================
   2. RECIPIENT DYNAMIC TEMPLATE PARSER
   ========================================================================== */
function parseRecipientVars(template, recipientObj) {
  if (!template) return "";
  let parsed = template;
  
  if (typeof recipientObj === 'object') {
    Object.keys(recipientObj).forEach(key => {
      const reg = new RegExp(`{{\\s*${key}\\s*}}`, 'gi');
      parsed = parsed.replace(reg, recipientObj[key] || '');
    });
  }
  return parsed;
}

/* ==========================================================================
   3. SPINTAX ENGINE
   ========================================================================== */
function parseSpintax(text) {
  if (!text) return "";
  let spun = text;
  const regex = /{([^{}]+)}/g;
  let iterations = 0;
  while (regex.test(spun) && iterations < 10) {
    spun = spun.replace(regex, (_, choices) => {
      const options = choices.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });
    iterations++;
  }
  return spun;
}

/* ==========================================================================
   4. TRANSPORTER POOL MANAGER
   ========================================================================== */
function getTransporter(email, appPassword) {
  const cleanEmail = email.toLowerCase().trim();
  const cacheKey = `${cleanEmail}_${appPassword.trim()}`;

  if (!transporterCache.has(cacheKey)) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      pool: true,
      maxConnections: 1,
      maxMessages: 100,
      rateLimit: 1,
      auth: { user: cleanEmail, pass: appPassword.trim() },
      tls: { rejectUnauthorized: true }
    });
    transporterCache.set(cacheKey, transporter);
  }
  return transporterCache.get(cacheKey);
}

/* ==========================================================================
   5. AUTHENTICATION & VERIFICATION ENDPOINTS
   ========================================================================== */
app.post("/api/auth", (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) return res.json({ success: true });
  return res.status(401).json({ success: false, message: "Unauthorized access" });
});

app.post("/api/verify-accounts", async (req, res) => {
  const { accounts } = req.body; // Array of { email, appPassword }
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return res.status(400).json({ success: false, message: "Accounts array required" });
  }

  const results = [];
  for (const acc of accounts) {
    try {
      const transporter = getTransporter(acc.email, acc.appPassword);
      await transporter.verify();
      results.push({ email: acc.email, status: 'valid' });
    } catch (err) {
      results.push({ email: acc.email, status: 'failed', error: err.message });
    }
  }
  return res.json({ success: true, results });
});

/* ==========================================================================
   6. ENTERPRISE STREAM ENGINE (MULTI-ACCOUNT ROTATION & SSE)
   ========================================================================== */
app.post("/api/send-stream", async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { accounts, senderName, subject, messageBody, recipients } = req.body;

  if (!Array.isArray(accounts) || accounts.length === 0 || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Invalid payload parameters" })}\n\n`);
    res.end();
    return;
  }

  activeSessions['global_stop'] = false;
  let accountIndex = 0;

  for (let index = 0; index < recipients.length; index++) {
    if (activeSessions['global_stop']) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Task terminated by user" })}\n\n`);
      break;
    }

    const item = recipients[index];
    const recipientEmail = (typeof item === 'string' ? item : item.email || "").trim();
    if (!recipientEmail) continue;

    // ROTATE ACCOUNTS ROUND-ROBIN
    const currentAccount = accounts[accountIndex % accounts.length];
    accountIndex++;

    res.write(': keep-alive\n\n');

    try {
      const transporter = getTransporter(currentAccount.email, currentAccount.appPassword);
      
      // 1. Spintax Processing
      let processedSubject = parseSpintax(subject);
      let processedBody = parseSpintax(messageBody);

      // 2. Variable Substitution (e.g., {{Name}})
      if (typeof item === 'object') {
        processedSubject = parseRecipientVars(processedSubject, item);
        processedBody = parseRecipientVars(processedBody, item);
      }

      // 3. Inject Invisible Polymorphic Noise to bypass duplicate content filters
      processedBody = injectPolymorphicNoise(processedBody);

      const uniqueRef = crypto.randomBytes(4).toString('hex').toUpperCase();
      const domain = currentAccount.email.split('@')[1] || 'gmail.com';
      const customMessageId = `<${Date.now()}.${uniqueRef}@${domain}>`;
      const timeStamp = new Date().toUTCString();

      const footerHtml = `
        <div style="margin-top: 25px; padding-top: 10px; border-top: 1px solid #edf2f7; font-size: 11px; color: #718096; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
          Security Verification Code: <strong>${uniqueRef}</strong> | Stamp: ${timeStamp}
        </div>
      `;

      const cleanSenderName = (senderName || "").replace(/["\r\n]/g, "").trim();

      const mailOptions = {
        from: cleanSenderName ? `"${cleanSenderName}" <${currentAccount.email}>` : currentAccount.email,
        replyTo: currentAccount.email,
        to: recipientEmail,
        subject: processedSubject,
        html: processedBody + footerHtml,
        messageId: customMessageId,
        headers: {
          'X-Entity-Ref-ID': uniqueRef,
          'X-Mailer': 'SecureMailConsole/2.0',
          'List-Unsubscribe': `<mailto:${currentAccount.email}?subject=unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          'X-Report-Abuse-To': `<mailto:${currentAccount.email}>`
        }
      };

      await transporter.sendMail(mailOptions);

      res.write(`data: ${JSON.stringify({
        success: true,
        recipient: recipientEmail,
        code: uniqueRef,
        sentFrom: currentAccount.email,
        progress: `${index + 1}/${recipients.length}`
      })}\n\n`);

    } catch (error) {
      console.error(`Failed sending to ${recipientEmail} via ${currentAccount.email}:`, error.message);
      res.write(`data: ${JSON.stringify({
        success: false,
        recipient: recipientEmail,
        sentFrom: currentAccount.email,
        error: error.message
      })}\n\n`);
    }

    // Dynamic Humanized Delay (4 to 8 Seconds)
    if (index < recipients.length - 1) {
      const delay = Math.floor(Math.random() * 4000) + 4000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  res.write("data: [DONE]\n\n");
  res.end();
});

app.post("/api/stop", (req, res) => {
  activeSessions['global_stop'] = true;
  res.json({ success: true, message: "Broadcast stop signal received" });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

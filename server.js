import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', true);

const SITE_PASSWORD = process.env.SITE_PASSWORD || 'Y##';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';

// Express Middleware Setup
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Active Sending Jobs Set
const runningJobs = new Set();

/* ==========================================================================
   ROOT ROUTE
   ========================================================================== */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ==========================================================================
   HELPER: CLOUDFLARE TURNSTILE VERIFICATION
   ========================================================================== */
async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET_KEY) return true;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: ip || ''
      })
    });
    const data = await response.json();
    return data.success;
  } catch (err) {
    console.error("Turnstile verification error:", err);
    return false;
  }
}

/* ==========================================================================
   SPINTAX PARSER ({Hi|Hello|Hey})
   ========================================================================== */
function processSpintax(text) {
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
   PLAIN TEXT FALLBACK GENERATOR
   ========================================================================== */
function makePlainText(html) {
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
   AUTHENTICATION ROUTES
   ========================================================================== */
app.post("/api/auth", (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ success: false, message: "Password is required" });
  if (password === SITE_PASSWORD) return res.json({ success: true, message: "Access granted" });
  return res.status(401).json({ success: false, message: "Incorrect password" });
});

app.post("/api/verify", async (req, res) => {
  const { email, appPassword, cfToken } = req.body;
  if (!email || !appPassword) return res.status(400).json({ success: false, message: "Email and App Password required" });

  if (cfToken && TURNSTILE_SECRET_KEY) {
    const isValid = await verifyTurnstile(cfToken, req.ip);
    if (!isValid) return res.status(400).json({ success: false, message: "Security check failed." });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: email.trim(), pass: appPassword }
    });
    await transporter.verify();
    return res.json({ success: true, message: "SMTP connection verified successfully" });
  } catch (error) {
    return res.status(401).json({ success: false, message: "Authentication failed. Check App Password." });
  }
});

/* ==========================================================================
   SSE STREAM ROUTE (FAST 2-SECOND INTERVAL ENGINE)
   ========================================================================== */
app.post("/api/send-stream", async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients, cfToken, sessionId } = req.body;
  const jobId = sessionId || `job_${Date.now()}`;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Missing required fields" })}\n\n`);
    res.end();
    return;
  }

  if (cfToken && TURNSTILE_SECRET_KEY) {
    const isValid = await verifyTurnstile(cfToken, req.ip);
    if (!isValid) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Turnstile verification failed" })}\n\n`);
      res.end();
      return;
    }
  }

  const cleanSender = email.toLowerCase().trim();
  const displayName = (senderName || "").replace(/"/g, "").trim();

  // Direct SSL Transporter
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true, // Direct SSL connection
    auth: {
      user: cleanSender,
      pass: appPassword
    },
    tls: {
      rejectUnauthorized: false
    }
  });

  runningJobs.add(jobId);

  for (let i = 0; i < recipients.length; i++) {
    // Check if stopped by user
    if (!runningJobs.has(jobId)) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Stopped by user" })}\n\n`);
      break;
    }

    const targetEmail = recipients[i] ? recipients[i].trim() : "";
    if (!targetEmail) continue;

    try {
      const finalSubject = processSpintax(subject);
      const finalBody = processSpintax(messageBody);
      const isHtml = /<[a-z][\s\S]*>/i.test(finalBody);

      // Unique RFC Message-ID to help avoid spam categorization
      const domain = cleanSender.split('@')[1] || 'gmail.com';
      const customMessageId = `<${Date.now()}.${Math.random().toString(36).substring(2, 10)}@${domain}>`;

      const mailPayload = {
        from: displayName ? `"${displayName}" <${cleanSender}>` : cleanSender,
        to: targetEmail,
        replyTo: cleanSender,
        subject: finalSubject,
        headers: {
          'Message-ID': customMessageId,
          'X-Mailer': 'GMailer/3.0',
          'X-Priority': '3'
        }
      };

      if (isHtml) {
        mailPayload.html = finalBody;
        mailPayload.text = makePlainText(finalBody);
      } else {
        mailPayload.text = finalBody;
      }

      await transporter.sendMail(mailPayload);
      res.write(`data: ${JSON.stringify({ success: true, recipient: targetEmail, index: i + 1, total: recipients.length })}\n\n`);

    } catch (err) {
      console.error(`Error sending to ${targetEmail}:`, err.message);
      res.write(`data: ${JSON.stringify({ success: false, recipient: targetEmail, error: err.message })}\n\n`);
    }

    // STRICT 2-SECOND DELAY (Fast Speed)
    if (i < recipients.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Exactly 2 Seconds
      res.write(': keep-alive\n\n');
    }
  }

  runningJobs.delete(jobId);
  transporter.close(); // Close SMTP Socket when finished
  res.write("data: [DONE]\n\n");
  res.end();
});

/* ==========================================================================
   STOP ROUTE
   ========================================================================== */
app.post("/api/stop", (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) {
    runningJobs.delete(sessionId);
  } else {
    runningJobs.clear();
  }
  res.json({ success: true, message: "Sending process stopped" });
});

/* ==========================================================================
   VERCEL HANDLER EXPORT
   ========================================================================== */
export default app;

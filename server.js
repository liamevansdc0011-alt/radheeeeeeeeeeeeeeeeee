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

const globalState = { isTerminated: false };
const activeTransporters = new Map();

const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ==========================================================================
   1. HIGH-PERFORMANCE DIRECT SSL TRANSPORTER ENGINE
   ========================================================================== */
function acquireSmtpClient(userEmail, appPassword) {
  const accountKey = `${userEmail.toLowerCase().trim()}_${appPassword.trim()}`;

  if (!activeTransporters.has(accountKey)) {
    const client = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true, // Native SSL Connection (Anti-Spam Optimized)
      auth: {
        user: userEmail.toLowerCase().trim(),
        pass: appPassword.replace(/\s+/g, '').trim()
      },
      pool: true,
      maxConnections: 7, // Parallel Streams for Batch Sending
      maxMessages: 1000,
      socketTimeout: 20000,
      connectionTimeout: 20000
    });

    activeTransporters.set(accountKey, client);
  }

  return activeTransporters.get(accountKey);
}

/* ==========================================================================
   2. RECIPIENT & CONTENT NORMALIZER
   ========================================================================== */
function parseRecipientInfo(rawInput) {
  let targetEmail = "";
  let fullDisplayName = "";

  if (typeof rawInput === 'object' && rawInput !== null) {
    targetEmail = (rawInput.email || rawInput.recipient || "").trim();
    fullDisplayName = (rawInput.name || rawInput.fullName || rawInput.first_name || "").trim();
  } else if (typeof rawInput === 'string') {
    const cleanStr = rawInput.trim();
    const formattedMatch = cleanStr.match(/^(?:"?([^"]*)"?\s)?<([^>]+)>$/);
    if (formattedMatch) {
      fullDisplayName = formattedMatch[1] ? formattedMatch[1].trim() : "";
      targetEmail = formattedMatch[2].trim();
    } else if (cleanStr.includes(',')) {
      const segments = cleanStr.split(',');
      if (segments[0].includes('@')) {
        targetEmail = segments[0].trim();
        fullDisplayName = segments[1].trim();
      } else {
        fullDisplayName = segments[0].trim();
        targetEmail = segments[1].trim();
      }
    } else {
      targetEmail = cleanStr;
    }
  }

  if (!fullDisplayName && targetEmail.includes('@')) {
    const emailPrefix = targetEmail.split('@')[0];
    fullDisplayName = emailPrefix.replace(/[0-9_.-]/g, ' ').trim();
  }

  const capitalizedName = fullDisplayName
    ? fullDisplayName.split(/\s+/).map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(' ')
    : "Valued Partner";

  const givenName = capitalizedName.split(' ')[0] || "there";
  const domainName = targetEmail.includes('@') ? targetEmail.split('@')[1] : "";

  return {
    email: targetEmail.toLowerCase(),
    name: capitalizedName,
    firstName: givenName,
    domain: domainName
  };
}

function processSpintax(templateStr) {
  if (!templateStr) return "";
  let parsedContent = String(templateStr);
  const spintaxRegex = /{([^{}]+)}/g;
  let maxLoopLimit = 0;

  while (spintaxRegex.test(parsedContent) && maxLoopLimit < 10) {
    parsedContent = parsedContent.replace(spintaxRegex, (_, choices) => {
      if (!choices.includes('|')) return `{${choices}}`;
      const selectionArray = choices.split('|');
      const selectedOption = selectionArray[Math.floor(Math.random() * selectionArray.length)];
      return selectedOption ? selectedOption.trim() : '';
    });
    maxLoopLimit++;
  }
  return parsedContent.replace(/[\{\}]/g, '').trim();
}

function renderPersonalizedText(bodyTemplate, recipientObj) {
  if (!bodyTemplate) return "";
  let compiledText = processSpintax(bodyTemplate);
  const formattedDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  compiledText = compiledText.replace(/{Name}/gi, recipientObj.name);
  compiledText = compiledText.replace(/{FirstName}/gi, recipientObj.firstName);
  compiledText = compiledText.replace(/{First_Name}/gi, recipientObj.firstName);
  compiledText = compiledText.replace(/{Email}/gi, recipientObj.email);
  compiledText = compiledText.replace(/{Domain}/gi, recipientObj.domain);
  compiledText = compiledText.replace(/{Date}/gi, formattedDate);

  return compiledText;
}

function convertHtmlToPlain(htmlContent) {
  if (!htmlContent) return "";
  return htmlContent
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
   3. ROUTE ENDPOINTS
   ========================================================================== */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === SITE_PASSWORD) {
    return res.json({ success: true, message: "Authentication Successful" });
  }
  return res.status(401).json({ success: false, message: "Invalid Access Key" });
});

app.post("/api/verify", async (req, res) => {
  const { email, appPassword } = req.body;
  if (!email || !appPassword) {
    return res.status(400).json({ success: false, message: "SMTP credentials missing" });
  }

  try {
    const smtpClient = acquireSmtpClient(email, appPassword);
    await smtpClient.verify();
    return res.json({ success: true, message: "SMTP Server Validated" });
  } catch (err) {
    return res.status(401).json({ success: false, message: "Authentication Failed. Verify App Password." });
  }
});

/* ==========================================================================
   4. STREAMING ENGINE (7 Parallel Threads x 3 Batches = ~8-9 Seconds Total)
   ========================================================================== */
app.post('/api/send-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const { email, appPassword, senderName, subject, messageBody, recipients } = req.body;

  if (!email || !appPassword || !Array.isArray(recipients) || recipients.length === 0) {
    res.write(`data: ${JSON.stringify({ success: false, error: "Malformed Payload Request" })}\n\n`);
    res.end();
    return;
  }

  const senderEmail = email.toLowerCase().trim();
  const cleanSenderName = (senderName || "").replace(/["\r\n]/g, "").trim();
  globalState.isTerminated = false;

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 2500);

  const smtpClient = acquireSmtpClient(email, appPassword);

  // High-Speed Engine Configuration: 7 Mails Per Parallel Batch
  const CONCURRENCY_LIMIT = 7;
  const BATCH_INTERVAL_MS = 2200; // Total 3 steps = ~8.8 Seconds

  for (let index = 0; index < recipients.length; index += CONCURRENCY_LIMIT) {
    if (globalState.isTerminated) {
      res.write(`data: ${JSON.stringify({ success: false, error: "Execution Stopped by Client" })}\n\n`);
      break;
    }

    const currentSubSet = recipients.slice(index, index + CONCURRENCY_LIMIT);

    const dispatchJobs = currentSubSet.map(async (rawContact) => {
      const contact = parseRecipientInfo(rawContact);

      if (!contact.email || !contact.email.includes('@')) {
        return { success: false, recipient: '', error: "Invalid Recipient Address" };
      }

      try {
        const finalSubject = renderPersonalizedText(subject, contact);
        const finalBody = renderPersonalizedText(messageBody, contact);
        const containsHtml = /<[a-z][\s\S]*>/i.test(finalBody);

        const senderDomain = senderEmail.split('@')[1] || 'gmail.com';
        const uniqueMsgId = `<${crypto.randomBytes(8).toString('hex')}.${Date.now()}@${senderDomain}>`;

        const mailPayload = {
          from: cleanSenderName ? `"${cleanSenderName}" <${senderEmail}>` : senderEmail,
          to: contact.name !== "Valued Partner" ? `"${contact.name}" <${contact.email}>` : contact.email,
          replyTo: senderEmail,
          subject: finalSubject || 'Important Update',
          messageId: uniqueMsgId,
          date: new Date()
        };

        if (containsHtml) {
          mailPayload.html = finalBody;
          mailPayload.text = convertHtmlToPlain(finalBody);
        } else {
          mailPayload.text = finalBody;
        }

        const deliveryInfo = await smtpClient.sendMail(mailPayload);

        return {
          success: true,
          recipient: contact.email,
          name: contact.name,
          ref: deliveryInfo.messageId || 'DISPATCHED'
        };

      } catch (sendErr) {
        return { success: false, recipient: contact.email, error: sendErr.message };
      }
    });

    const jobResults = await Promise.all(dispatchJobs);

    for (const resultEntry of jobResults) {
      res.write(`data: ${JSON.stringify(resultEntry)}\n\n`);
    }

    if (index + CONCURRENCY_LIMIT < recipients.length) {
      await waitFor(BATCH_INTERVAL_MS);
    }
  }

  clearInterval(heartbeat);
  res.write("data: [DONE]\n\n");
  res.end();
});

app.post('/api/stop', (req, res) => {
  globalState.isTerminated = true;
  res.json({ success: true, message: "Process Halt Signal Received" });
});

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  app.listen(PORT, () => console.log(`🚀 Clean Inboxing Server Active on Port ${PORT}`));
}

export default app;

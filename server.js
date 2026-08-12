import "dotenv/config";
import express from "express";
import nodemailer from "nodemailer";
import cors from "cors";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const SITE_PASSWORD = process.env.SITE_PASSWORD || "##";

// Express Middleware Setup
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

const activeSessions = {};
const transporters = new Map();

/* ==========================================================================
   TRANSPORTER POOLING
   ========================================================================== */

function getTransporter(email, appPassword) {
  const cleanEmail = String(email).toLowerCase().trim();

  // Don't put the raw password directly into the cache key.
  const passwordHash = crypto
    .createHash("sha256")
    .update(String(appPassword))
    .digest("hex");

  const cacheKey = `${cleanEmail}_${passwordHash}`;

  if (!transporters.has(cacheKey)) {
    const transporter = nodemailer.createTransport({
      service: "gmail",

      auth: {
        user: cleanEmail,
        pass: appPassword
      },

      pool: true,
      maxConnections: 3,
      maxMessages: 100,

      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000
    });

    transporters.set(cacheKey, transporter);
  }

  return transporters.get(cacheKey);
}

/* ==========================================================================
   REFERENCE ID
   ========================================================================== */

function createReferenceId() {
  const date = new Date();

  const datePart =
    date.getFullYear().toString() +
    String(date.getMonth() + 1).padStart(2, "0") +
    String(date.getDate()).padStart(2, "0");

  const randomPart = crypto
    .randomBytes(4)
    .toString("hex")
    .toUpperCase();

  return `REF-${datePart}-${randomPart}`;
}

/* ==========================================================================
   SPINTAX PARSER
   Example: {Hi|Hello|Hey}
   ========================================================================== */

function parseSpintax(text) {
  if (!text) return "";

  let spun = String(text);
  const regex = /{([^{}]+)}/g;

  let iterations = 0;

  while (regex.test(spun) && iterations < 10) {
    spun = spun.replace(regex, (_, choices) => {
      const options = choices
        .split("|")
        .map((item) => item.trim())
        .filter(Boolean);

      if (!options.length) return "";

      return options[
        Math.floor(Math.random() * options.length)
      ];
    });

    iterations++;
  }

  return spun;
}

/* ==========================================================================
   HTML TO PLAIN TEXT FALLBACK
   ========================================================================== */

function convertHtmlToText(html) {
  if (!html) return "";

  return String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n\s*\n/g, "\n\n")
    .trim();
}

/* ==========================================================================
   HTML ESCAPE
   ========================================================================== */

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ==========================================================================
   BASIC EMAIL VALIDATION
   ========================================================================== */

function isValidEmail(email) {
  if (!email || email.length > 254) {
    return false;
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/* ==========================================================================
   AUTHENTICATION ROUTES
   ========================================================================== */

app.post("/api/auth", (req, res) => {
  const { password } = req.body || {};

  if (password === SITE_PASSWORD) {
    return res.json({
      success: true
    });
  }

  return res.status(401).json({
    success: false,
    message: "Incorrect password"
  });
});

/* ==========================================================================
   SMTP VERIFY
   ========================================================================== */

app.post("/api/verify", async (req, res) => {
  const { email, appPassword } = req.body || {};

  if (!email || !appPassword) {
    return res.status(400).json({
      success: false,
      message: "Credentials required"
    });
  }

  const cleanEmail = String(email).toLowerCase().trim();

  if (!isValidEmail(cleanEmail)) {
    return res.status(400).json({
      success: false,
      message: "Invalid email address"
    });
  }

  try {
    const transporter = getTransporter(
      cleanEmail,
      appPassword
    );

    await transporter.verify();

    return res.json({
      success: true,
      message: "SMTP verified successfully"
    });
  } catch (error) {
    console.error(
      "SMTP verification error:",
      error.message
    );

    return res.status(401).json({
      success: false,
      message:
        "Authentication failed. Check App Password."
    });
  }
});

/* ==========================================================================
   SSE STREAM ROUTE
   ========================================================================== */

app.post("/api/send-stream", async (req, res) => {
  const {
    email,
    appPassword,
    senderName,
    subject,
    messageBody,
    recipients
  } = req.body || {};

  /*
   * IMPORTANT:
   * These are the SAME fields used by your original frontend.
   */

  if (
    !email ||
    !appPassword ||
    !Array.isArray(recipients) ||
    recipients.length === 0
  ) {
    res.write(
      `data: ${JSON.stringify({
        success: false,
        error: "Missing required fields"
      })}\n\n`
    );

    res.end();
    return;
  }

  const senderEmail =
    String(email).toLowerCase().trim();

  const cleanSenderName =
    String(senderName || "")
      .replace(/[\r\n"]/g, "")
      .trim();

  if (!isValidEmail(senderEmail)) {
    res.write(
      `data: ${JSON.stringify({
        success: false,
        error: "Invalid sender email"
      })}\n\n`
    );

    res.end();
    return;
  }

  /*
   * Remove empty + duplicate + invalid recipients.
   */

  const cleanRecipients = [
    ...new Set(
      recipients
        .map((item) =>
          String(item || "")
            .trim()
            .toLowerCase()
        )
        .filter(isValidEmail)
    )
  ];

  if (cleanRecipients.length === 0) {
    res.write(
      `data: ${JSON.stringify({
        success: false,
        error: "No valid recipients found"
      })}\n\n`
    );

    res.end();
    return;
  }

  /*
   * SSE headers
   */

  res.setHeader(
    "Content-Type",
    "text/event-stream"
  );

  res.setHeader(
    "Cache-Control",
    "no-cache, no-transform"
  );

  res.setHeader(
    "Connection",
    "keep-alive"
  );

  res.setHeader(
    "X-Accel-Buffering",
    "no"
  );

  /*
   * Same global stop behavior as your original code.
   * This keeps your existing frontend compatible.
   */

  activeSessions.global_stop = false;

  /*
   * Create a batch reference.
   */

  const batchReferenceId =
    createReferenceId();

  res.write(
    `data: ${JSON.stringify({
      type: "start",
      success: true,
      referenceId: batchReferenceId,
      total: cleanRecipients.length
    })}\n\n`
  );

  try {
    /*
     * Create transporter ONCE.
     */

    const transporter = getTransporter(
      senderEmail,
      appPassword
    );

    /*
     * Verify connection once.
     */

    await transporter.verify();

    /*
     * Send one recipient at a time.
     */

    for (
      let index = 0;
      index < cleanRecipients.length;
      index++
    ) {
      /*
       * Stop check
       */

      if (activeSessions.global_stop) {
        res.write(
          `data: ${JSON.stringify({
            success: false,
            error: "Stopped by user"
          })}\n\n`
        );

        break;
      }

      const recipient =
        cleanRecipients[index];

      /*
       * Keep connection alive.
       */

      res.write(": keep-alive\n\n");

      /*
       * Every email gets its OWN reference ID.
       */

      const referenceId =
        createReferenceId();

      try {
        /*
         * Spintax
         */

        const spunSubject =
          parseSpintax(subject || "");

        const spunBody =
          parseSpintax(messageBody || "");

        /*
         * Detect HTML
         */

        const isHtml =
          /<[a-z][\s\S]*>/i.test(
            spunBody
          );

        /*
         * Reference footer
         */

        const safeReference =
          escapeHtml(referenceId);

        const referenceText =
          `\n\nReference ID: ${referenceId}`;

        const referenceHtml = `
          <div style="
            margin-top:20px;
            padding-top:10px;
            border-top:1px solid #ddd;
            color:#777;
            font-size:11px;
            font-family:Arial,sans-serif;
          ">
            Reference ID: ${safeReference}
          </div>
        `;

        /*
         * Mail options
         */

        const mailOptions = {
          from: cleanSenderName
            ? `"${cleanSenderName}" <${senderEmail}>`
            : senderEmail,

          to: recipient,

          subject: spunSubject,

          /*
           * Useful for tracking the individual message
           * on your own system.
           */
          headers: {
            "X-Reference-ID": referenceId
          }
        };

        /*
         * HTML + plain text
         */

        if (isHtml) {
          mailOptions.html =
            spunBody +
            referenceHtml;

          mailOptions.text =
            convertHtmlToText(
              spunBody
            ) +
            referenceText;
        } else {
          mailOptions.text =
            spunBody +
            referenceText;
        }

        /*
         * SEND
         */

        await transporter.sendMail(
          mailOptions
        );

        /*
         * Success event
         */

        res.write(
          `data: ${JSON.stringify({
            success: true,
            recipient,
            referenceId,
            index: index + 1,
            total: cleanRecipients.length
          })}\n\n`
        );
      } catch (error) {
        /*
         * Log server-side only.
         * Don't expose complete SMTP internals
         * to the browser.
         */

        console.error(
          `Error sending to ${recipient}:`,
          error.message
        );

        res.write(
          `data: ${JSON.stringify({
            success: false,
            recipient,
            error:
              "Email could not be delivered",
            index: index + 1,
            total: cleanRecipients.length
          })}\n\n`
        );
      }

      /*
       * Conservative delay.
       *
       * This is intentionally not rapid-fire sending.
       */

      if (
        index <
        cleanRecipients.length - 1
      ) {
        await new Promise(
          (resolve) =>
            setTimeout(resolve, 3000)
        );
      }
    }
  } catch (error) {
    console.error(
      "Sending process error:",
      error.message
    );

    res.write(
      `data: ${JSON.stringify({
        success: false,
        error:
          "Email sending process failed"
      })}\n\n`
    );
  }

  /*
   * Complete
   */

  res.write(
    "data: [DONE]\n\n"
  );

  res.end();
});

/* ==========================================================================
   STOP ROUTE
   ========================================================================== */

app.post("/api/stop", (req, res) => {
  activeSessions.global_stop = true;

  return res.json({
    success: true,
    message:
      "Stop process registered"
  });
});

/* ==========================================================================
   HEALTH CHECK
   ========================================================================== */

app.get("/api/health", (req, res) => {
  return res.json({
    success: true,
    status: "online"
  });
});

/* ==========================================================================
   VERCEL / SERVERLESS HANDLER
   ========================================================================== */

export default app;

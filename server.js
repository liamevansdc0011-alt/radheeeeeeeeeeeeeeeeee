import "dotenv/config";
import express from "express";
import nodemailer from "nodemailer";
import cors from "cors";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/

const PORT = Number(process.env.PORT || 3000);
const SITE_PASSWORD = process.env.SITE_PASSWORD;

if (!SITE_PASSWORD) {
  throw new Error("SITE_PASSWORD is required in environment variables.");
}

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";

/*
 * Conservative sending interval.
 * This is intentionally NOT designed for rapid bulk sending.
 */
const SEND_DELAY_MS = 3000;

/*
 * Maximum recipients allowed in one job.
 * Keep this within your provider's acceptable usage.
 */
const MAX_RECIPIENTS_PER_JOB = 100;

/*
|--------------------------------------------------------------------------
| EXPRESS
|--------------------------------------------------------------------------
*/

app.use(
  cors({
    origin: FRONTEND_ORIGIN,
  })
);

app.use(express.json({ limit: "5mb" }));

app.use(express.static(path.join(__dirname, "public")));

/*
|--------------------------------------------------------------------------
| IN-MEMORY JOB STORAGE
|--------------------------------------------------------------------------
|
| For production with multiple server instances, replace this with
| Redis/database-backed job storage.
|
*/

const jobs = new Map();
const transporters = new Map();

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function createId() {
  return crypto.randomUUID();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function cleanName(name) {
  return String(name || "")
    .replace(/[\r\n"]/g, "")
    .trim()
    .slice(0, 100);
}

function isValidEmail(email) {
  if (!email || email.length > 254) return false;

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/*
|--------------------------------------------------------------------------
| SPINTAX
|--------------------------------------------------------------------------
|
| Example:
| {Hi|Hello|Hey} {{firstName}}
|
| This implementation only handles simple {A|B|C} choices.
|--------------------------------------------------------------------------
*/

function parseSpintax(text) {
  if (!text) return "";

  let result = String(text);
  const regex = /{([^{}]+)}/g;

  let iterations = 0;

  while (regex.test(result) && iterations < 10) {
    result = result.replace(regex, (_, choices) => {
      const options = choices
        .split("|")
        .map((item) => item.trim())
        .filter(Boolean);

      if (options.length === 0) return "";

      return options[Math.floor(Math.random() * options.length)];
    });

    iterations++;
  }

  return result;
}

/*
|--------------------------------------------------------------------------
| HTML -> TEXT
|--------------------------------------------------------------------------
*/

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
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/*
|--------------------------------------------------------------------------
| TRANSPORTER
|--------------------------------------------------------------------------
*/

function getTransporter(email, appPassword) {
  const cleanSender = cleanEmail(email);

  /*
   * Hash is used as the cache identifier rather than putting the
   * raw App Password directly into the Map key.
   */
  const passwordHash = crypto
    .createHash("sha256")
    .update(String(appPassword))
    .digest("hex");

  const cacheKey = `${cleanSender}:${passwordHash}`;

  if (!transporters.has(cacheKey)) {
    const transporter = nodemailer.createTransport({
      service: "gmail",

      auth: {
        user: cleanSender,
        pass: appPassword,
      },

      /*
       * Keep connections limited.
       */
      pool: true,
      maxConnections: 2,
      maxMessages: 50,

      /*
       * Network safety.
       */
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });

    transporters.set(cacheKey, transporter);
  }

  return transporters.get(cacheKey);
}

/*
|--------------------------------------------------------------------------
| AUTH
|--------------------------------------------------------------------------
*/

app.post("/api/auth", (req, res) => {
  const { password } = req.body || {};

  if (!password) {
    return res.status(400).json({
      success: false,
      message: "Password required",
    });
  }

  if (password !== SITE_PASSWORD) {
    return res.status(401).json({
      success: false,
      message: "Incorrect password",
    });
  }

  return res.json({
    success: true,
  });
});

/*
|--------------------------------------------------------------------------
| SMTP VERIFY
|--------------------------------------------------------------------------
*/

app.post("/api/verify", async (req, res) => {
  const { email, appPassword } = req.body || {};

  if (!email || !appPassword) {
    return res.status(400).json({
      success: false,
      message: "Email and App Password are required",
    });
  }

  const senderEmail = cleanEmail(email);

  if (!isValidEmail(senderEmail)) {
    return res.status(400).json({
      success: false,
      message: "Invalid email address",
    });
  }

  try {
    const transporter = getTransporter(senderEmail, appPassword);

    await transporter.verify();

    return res.json({
      success: true,
      message: "SMTP verified successfully",
    });
  } catch (error) {
    console.error("SMTP verification failed:", error.message);

    return res.status(401).json({
      success: false,
      message: "SMTP authentication failed",
    });
  }
});

/*
|--------------------------------------------------------------------------
| CREATE JOB
|--------------------------------------------------------------------------
|
| A job gets its own ID.
| This prevents one user's stop request from stopping every sender.
|--------------------------------------------------------------------------
*/

app.post("/api/send-stream", async (req, res) => {
  const {
    email,
    appPassword,
    senderName,
    subject,
    messageBody,
    recipients,
    consent,
    unsubscribeUrl,
  } = req.body || {};

  /*
   * Basic validation
   */
  if (
    !email ||
    !appPassword ||
    !subject ||
    !messageBody ||
    !Array.isArray(recipients)
  ) {
    return res.status(400).json({
      success: false,
      error: "Missing required fields",
    });
  }

  /*
   * Explicit permission requirement.
   */
  if (consent !== true) {
    return res.status(400).json({
      success: false,
      error:
        "Recipients must be permission-based. Set consent=true only when you are authorized to contact them.",
    });
  }

  if (recipients.length === 0) {
    return res.status(400).json({
      success: false,
      error: "Recipient list is empty",
    });
  }

  if (recipients.length > MAX_RECIPIENTS_PER_JOB) {
    return res.status(400).json({
      success: false,
      error: `Maximum ${MAX_RECIPIENTS_PER_JOB} recipients allowed per job`,
    });
  }

  const senderEmail = cleanEmail(email);
  const cleanSenderName = cleanName(senderName);

  if (!isValidEmail(senderEmail)) {
    return res.status(400).json({
      success: false,
      error: "Invalid sender email",
    });
  }

  /*
   * Clean + validate + deduplicate recipients.
   */
  const uniqueRecipients = [
    ...new Set(
      recipients
        .map(cleanEmail)
        .filter(isValidEmail)
    ),
  ];

  if (uniqueRecipients.length === 0) {
    return res.status(400).json({
      success: false,
      error: "No valid recipients found",
    });
  }

  /*
   * Optional unsubscribe URL.
   */
  let cleanUnsubscribeUrl = "";

  if (unsubscribeUrl) {
    try {
      const parsed = new URL(unsubscribeUrl);

      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("Invalid protocol");
      }

      cleanUnsubscribeUrl = parsed.toString();
    } catch {
      return res.status(400).json({
        success: false,
        error: "Invalid unsubscribe URL",
      });
    }
  }

  /*
   * SSE setup
   */
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const jobId = createId();

  const job = {
    id: jobId,
    stopped: false,
    startedAt: new Date(),
    sender: senderEmail,
    total: uniqueRecipients.length,
    sent: 0,
    failed: 0,
  };

  jobs.set(jobId, job);

  /*
   * Tell frontend which job was created.
   */
  res.write(
    `data: ${JSON.stringify({
      type: "job",
      jobId,
      total: uniqueRecipients.length,
    })}\n\n`
  );

  /*
   * Cleanup if client disconnects.
   */
  req.on("close", () => {
    job.clientDisconnected = true;
  });

  try {
    const transporter = getTransporter(senderEmail, appPassword);

    /*
     * Verify once before starting.
     */
    await transporter.verify();

    for (let index = 0; index < uniqueRecipients.length; index++) {
      if (job.stopped) {
        res.write(
          `data: ${JSON.stringify({
            type: "stopped",
            jobId,
          })}\n\n`
        );

        break;
      }

      const recipient = uniqueRecipients[index];

      /*
       * Keep-alive.
       */
      res.write(": keep-alive\n\n");

      try {
        const spunSubject = parseSpintax(subject);
        const spunBody = parseSpintax(messageBody);

        const isHtml = /<[a-z][\s\S]*>/i.test(spunBody);

        const textBody = isHtml
          ? convertHtmlToText(spunBody)
          : spunBody;

        /*
         * Add unsubscribe information when supplied.
         */
        const finalText = cleanUnsubscribeUrl
          ? `${textBody}\n\nTo stop receiving these emails:\n${cleanUnsubscribeUrl}`
          : textBody;

        const finalHtml = isHtml
          ? cleanUnsubscribeUrl
            ? `${spunBody}
                <br><br>
                <hr>
                <p style="font-size:12px;color:#666;">
                  To stop receiving these emails:
                  <a href="${cleanUnsubscribeUrl}">Unsubscribe</a>
                </p>`
            : spunBody
          : undefined;

        const mailOptions = {
          from: cleanSenderName
            ? `"${cleanSenderName}" <${senderEmail}>`
            : senderEmail,

          to: recipient,

          subject: spunSubject,

          text: finalText,

          /*
           * Helps mail clients understand that this is a normal
           * one-to-one message.
           */
          headers: {
            "X-Auto-Response-Suppress": "All",
          },
        };

        if (finalHtml) {
          mailOptions.html = finalHtml;
        }

        await transporter.sendMail(mailOptions);

        job.sent++;

        res.write(
          `data: ${JSON.stringify({
            type: "sent",
            success: true,
            recipient,
            index: index + 1,
            total: uniqueRecipients.length,
            sent: job.sent,
            failed: job.failed,
          })}\n\n`
        );
      } catch (error) {
        job.failed++;

        /*
         * Do NOT expose raw SMTP errors to browser.
         */
        console.error(
          `Email failed for ${recipient}:`,
          error.message
        );

        res.write(
          `data: ${JSON.stringify({
            type: "failed",
            success: false,
            recipient,
            index: index + 1,
            total: uniqueRecipients.length,
            sent: job.sent,
            failed: job.failed,
            error: "Email could not be delivered",
          })}\n\n`
        );
      }

      /*
       * Conservative delay.
       *
       * This intentionally avoids rapid-fire bulk sending.
       */
      if (index < uniqueRecipients.length - 1) {
        await sleep(SEND_DELAY_MS);
      }
    }

    /*
     * Finished.
     */
    res.write(
      `data: ${JSON.stringify({
        type: "complete",
        jobId,
        total: uniqueRecipients.length,
        sent: job.sent,
        failed: job.failed,
      })}\n\n`
    );

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    console.error("Sending job failed:", error.message);

    res.write(
      `data: ${JSON.stringify({
        type: "error",
        jobId,
        error: "Sending job could not be completed",
      })}\n\n`
    );

    res.end();
  } finally {
    /*
     * Keep completed job for a short time.
     */
    setTimeout(() => {
      jobs.delete(jobId);
    }, 10 * 60 * 1000);
  }
});

/*
|--------------------------------------------------------------------------
| STOP JOB
|--------------------------------------------------------------------------
*/

app.post("/api/stop", (req, res) => {
  const { jobId } = req.body || {};

  if (!jobId) {
    return res.status(400).json({
      success: false,
      message: "jobId is required",
    });
  }

  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Job not found or already finished",
    });
  }

  job.stopped = true;

  return res.json({
    success: true,
    message: "Stop request registered",
    jobId,
  });
});

/*
|--------------------------------------------------------------------------
| JOB STATUS
|--------------------------------------------------------------------------
*/

app.get("/api/job/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      success: false,
      message: "Job not found",
    });
  }

  return res.json({
    success: true,
    job: {
      id: job.id,
      total: job.total,
      sent: job.sent,
      failed: job.failed,
      stopped: job.stopped,
      startedAt: job.startedAt,
    },
  });
});

/*
|--------------------------------------------------------------------------
| HEALTH CHECK
|--------------------------------------------------------------------------
*/

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    service: "email-service",
    status: "healthy",
  });
});

/*
|--------------------------------------------------------------------------
| VERCEL / SERVERLESS
|--------------------------------------------------------------------------
*/

export default app;

/*
|--------------------------------------------------------------------------
| LOCAL DEVELOPMENT
|--------------------------------------------------------------------------
*/

if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

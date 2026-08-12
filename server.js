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

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/

const SITE_PASSWORD = process.env.SITE_PASSWORD;

if (!SITE_PASSWORD) {
  throw new Error("SITE_PASSWORD is missing in environment variables.");
}

/*
 * Keep this conservative.
 * This is for legitimate / permission-based sending,
 * not rapid bulk sending.
 */
const SEND_DELAY_MS = Number(process.env.SEND_DELAY_MS || 3000);

/*
 * Protect the server from accidentally huge jobs.
 */
const MAX_RECIPIENTS = Number(
  process.env.MAX_RECIPIENTS || 100
);

/*
|--------------------------------------------------------------------------
| MIDDLEWARE
|--------------------------------------------------------------------------
*/

app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || true,
  })
);

app.use(
  express.json({
    limit: "5mb",
  })
);

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

/*
|--------------------------------------------------------------------------
| STORAGE
|--------------------------------------------------------------------------
*/

const activeSessions = new Map();
const transporters = new Map();

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/*
 * Unique reference ID.
 *
 * Example:
 * REF-20260812-X7K4P9
 */
function createReferenceId() {
  const date = new Date();

  const datePart =
    date.getUTCFullYear().toString() +
    String(date.getUTCMonth() + 1).padStart(2, "0") +
    String(date.getUTCDate()).padStart(2, "0");

  const randomPart = crypto
    .randomBytes(4)
    .toString("hex")
    .toUpperCase();

  return `REF-${datePart}-${randomPart}`;
}

function cleanEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function cleanSenderName(name) {
  return String(name || "")
    .replace(/[\r\n"]/g, "")
    .trim()
    .slice(0, 100);
}

function isValidEmail(email) {
  if (!email || email.length > 254) {
    return false;
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/*
|--------------------------------------------------------------------------
| SPINTAX
|--------------------------------------------------------------------------
|
| Example:
| {Hi|Hello|Hey}
|
*/

function parseSpintax(text) {
  if (!text) {
    return "";
  }

  let result = String(text);

  const regex = /{([^{}]+)}/g;

  let iterations = 0;

  while (regex.test(result) && iterations < 10) {
    result = result.replace(
      regex,
      (_, choices) => {
        const options = choices
          .split("|")
          .map((item) => item.trim())
          .filter(Boolean);

        if (!options.length) {
          return "";
        }

        return options[
          Math.floor(
            Math.random() * options.length
          )
        ];
      }
    );

    iterations++;
  }

  return result;
}

/*
|--------------------------------------------------------------------------
| HTML ESCAPE
|--------------------------------------------------------------------------
*/

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/*
|--------------------------------------------------------------------------
| HTML -> TEXT
|--------------------------------------------------------------------------
*/

function convertHtmlToText(html) {
  if (!html) {
    return "";
  }

  return String(html)
    .replace(
      /<style[^>]*>[\s\S]*?<\/style>/gi,
      ""
    )
    .replace(
      /<script[^>]*>[\s\S]*?<\/script>/gi,
      ""
    )
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
   * Do not put the raw password into the cache key.
   */
  const passwordHash = crypto
    .createHash("sha256")
    .update(String(appPassword))
    .digest("hex");

  const cacheKey =
    `${cleanSender}:${passwordHash}`;

  if (!transporters.has(cacheKey)) {
    const transporter =
      nodemailer.createTransport({
        service: "gmail",

        auth: {
          user: cleanSender,
          pass: appPassword,
        },

        pool: true,

        maxConnections: 2,

        maxMessages: 50,

        connectionTimeout: 15000,

        greetingTimeout: 15000,

        socketTimeout: 30000,
      });

    transporters.set(
      cacheKey,
      transporter
    );
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

  if (
    typeof password !== "string" ||
    !password
  ) {
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
  const {
    email,
    appPassword,
  } = req.body || {};

  if (!email || !appPassword) {
    return res.status(400).json({
      success: false,
      message: "Credentials required",
    });
  }

  const senderEmail =
    cleanEmail(email);

  if (!isValidEmail(senderEmail)) {
    return res.status(400).json({
      success: false,
      message: "Invalid email address",
    });
  }

  try {
    const transporter =
      getTransporter(
        senderEmail,
        appPassword
      );

    await transporter.verify();

    return res.json({
      success: true,
      message:
        "SMTP verified successfully",
    });
  } catch (error) {
    console.error(
      "SMTP verification error:",
      error.message
    );

    return res.status(401).json({
      success: false,
      message:
        "Authentication failed. Check App Password.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| SEND STREAM
|--------------------------------------------------------------------------
*/

app.post(
  "/api/send-stream",
  async (req, res) => {
    /*
     * Same request fields as your old frontend.
     */
    const {
      email,
      appPassword,
      senderName,
      subject,
      messageBody,
      recipients,
    } = req.body || {};

    /*
     * Validation
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
          error: "Missing required fields",
        })}\n\n`
      );

      return res.end();
    }

    if (recipients.length > MAX_RECIPIENTS) {
      res.write(
        `data: ${JSON.stringify({
          success: false,
          error:
            `Maximum ${MAX_RECIPIENTS} recipients allowed per job`,
        })}\n\n`
      );

      return res.end();
    }

    const senderEmail =
      cleanEmail(email);

    if (!isValidEmail(senderEmail)) {
      res.write(
        `data: ${JSON.stringify({
          success: false,
          error: "Invalid sender email",
        })}\n\n`
      );

      return res.end();
    }

    const cleanName =
      cleanSenderName(senderName);

    /*
     * Clean and deduplicate recipients.
     */
    const uniqueRecipients = [
      ...new Set(
        recipients
          .map(cleanEmail)
          .filter(isValidEmail)
      ),
    ];

    if (!uniqueRecipients.length) {
      res.write(
        `data: ${JSON.stringify({
          success: false,
          error:
            "No valid recipients found",
        })}\n\n`
      );

      return res.end();
    }

    /*
     * SSE
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
     * Unique session for this request.
     */
    const sessionId = createReferenceId();

    activeSessions.set(
      sessionId,
      {
        stopped: false,
      }
    );

    /*
     * Tell frontend the session/reference.
     */
    res.write(
      `data: ${JSON.stringify({
        type: "session",
        sessionId,
        total:
          uniqueRecipients.length,
      })}\n\n`
    );

    try {
      const transporter =
        getTransporter(
          senderEmail,
          appPassword
        );

      /*
       * Verify before sending.
       */
      await transporter.verify();

      for (
        let index = 0;
        index < uniqueRecipients.length;
        index++
      ) {
        const session =
          activeSessions.get(
            sessionId
          );

        /*
         * Stop only this job.
         */
        if (
          !session ||
          session.stopped
        ) {
          res.write(
            `data: ${JSON.stringify({
              success: false,
              error:
                "Stopped by user",
              sessionId,
            })}\n\n`
          );

          break;
        }

        const recipient =
          uniqueRecipients[index];

        /*
         * Keep connection alive.
         */
        res.write(
          ": keep-alive\n\n"
        );

        /*
         * Every recipient gets a fresh reference.
         */
        const referenceId =
          createReferenceId();

        try {
          /*
           * Generate content.
           */
          const spunSubject =
            parseSpintax(
              subject || ""
            );

          const spunBody =
            parseSpintax(
              messageBody || ""
            );

          const isHtml =
            /<[a-z][\s\S]*>/i.test(
              spunBody
            );

          /*
           * Reference footer.
           */
          const safeReference =
            escapeHtml(
              referenceId
            );

          /*
           * Text reference.
           */
          const referenceText =
            `\n\nReference ID: ${referenceId}`;

          /*
           * HTML reference.
           */
          const referenceHtml = `
              <div
                style="
                  margin-top:24px;
                  padding-top:12px;
                  border-top:1px solid #e5e5e5;
                  color:#777;
                  font-size:11px;
                  font-family:Arial,sans-serif;
                "
              >
                Reference ID:
                <span>${safeReference}</span>
              </div>
            `;

          const mailOptions = {
            from: cleanName
              ? `"${cleanName}" <${senderEmail}>`
              : senderEmail,

            to: recipient,

            subject:
              spunSubject,

            /*
             * Useful for internal identification.
             */
            headers: {
              "X-Reference-ID":
                referenceId,

              "X-Mailer":
                "Permission-Based Email Service",
            },
          };

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
           * Send.
           */
          await transporter.sendMail(
            mailOptions
          );

          res.write(
            `data: ${JSON.stringify({
              success: true,
              recipient,
              referenceId,
              index: index + 1,
              total:
                uniqueRecipients.length,
            })}\n\n`
          );
        } catch (error) {
          /*
           * Do not expose raw SMTP errors.
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
              total:
                uniqueRecipients.length,
            })}\n\n`
          );
        }

        /*
         * Conservative interval.
         */
        if (
          index <
          uniqueRecipients.length - 1
        ) {
          await sleep(
            SEND_DELAY_MS
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
            "Email sending process failed",
        })}\n\n`
      );
    } finally {
      activeSessions.delete(
        sessionId
      );

      res.write(
        "data: [DONE]\n\n"
      );

      res.end();
    }
  }
);

/*
|--------------------------------------------------------------------------
| STOP
|--------------------------------------------------------------------------
|
| Existing frontend can continue calling:
| POST /api/stop
|
| If sessionId is supplied, only that job stops.
|
| If old frontend doesn't supply sessionId,
| global stop is NOT used anymore.
|--------------------------------------------------------------------------
*/

app.post("/api/stop", (req, res) => {
  const {
    sessionId,
  } = req.body || {};

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      message:
        "sessionId is required",
    });
  }

  const session =
    activeSessions.get(
      sessionId
    );

  if (!session) {
    return res.json({
      success: true,
      message:
        "Session already finished",
    });
  }

  session.stopped = true;

  return res.json({
    success: true,
    message:
      "Stop process registered",
    sessionId,
  });
});

/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy",
  });
});

/*
|--------------------------------------------------------------------------
| VERCEL
|--------------------------------------------------------------------------
*/

export default app;

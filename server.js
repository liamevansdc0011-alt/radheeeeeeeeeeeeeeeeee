```javascript
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

// ============================================================
// EXPRESS MIDDLEWARE
// ============================================================

app.use(cors());

app.use(
  express.json({
    limit: "50mb"
  })
);

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

// ============================================================
// STORAGE
// ============================================================

const activeSessions = {};
const transporters = new Map();

// ============================================================
// TRANSPORTER POOL
// ============================================================

function getTransporter(email, appPassword) {
  const cleanEmail = String(email)
    .toLowerCase()
    .trim();

  /*
   * Password ko raw cache key me store nahi kar rahe.
   */
  const passwordHash = crypto
    .createHash("sha256")
    .update(String(appPassword))
    .digest("hex");

  const cacheKey =
    `${cleanEmail}_${passwordHash}`;

  if (!transporters.has(cacheKey)) {
    const transporter =
      nodemailer.createTransport({
        service: "gmail",

        auth: {
          user: cleanEmail,
          pass: appPassword
        },

        /*
         * SMTP connection pooling
         */
        pool: true,
        maxConnections: 2,
        maxMessages: 50,

        /*
         * Network timeouts
         */
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 30000
      });

    transporters.set(
      cacheKey,
      transporter
    );
  }

  return transporters.get(cacheKey);
}

// ============================================================
// EMAIL VALIDATION
// ============================================================

function isValidEmail(email) {
  if (!email) {
    return false;
  }

  if (email.length > 254) {
    return false;
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    email
  );
}

// ============================================================
// REFERENCE ID
// ============================================================

function createReferenceId() {
  const now = new Date();

  const date =
    now.getUTCFullYear().toString() +
    String(
      now.getUTCMonth() + 1
    ).padStart(2, "0") +
    String(
      now.getUTCDate()
    ).padStart(2, "0");

  const random =
    crypto
      .randomBytes(5)
      .toString("hex")
      .toUpperCase();

  return `REF-${date}-${random}`;
}

// ============================================================
// SPINTAX
// Example: {Hi|Hello|Hey}
// ============================================================

function parseSpintax(text) {
  if (!text) {
    return "";
  }

  let result = String(text);

  const regex = /{([^{}]+)}/g;

  let iterations = 0;

  while (
    regex.test(result) &&
    iterations < 10
  ) {
    result = result.replace(
      regex,
      (_, choices) => {
        const options = choices
          .split("|")
          .map((item) =>
            item.trim()
          )
          .filter(Boolean);

        if (!options.length) {
          return "";
        }

        return options[
          Math.floor(
            Math.random() *
              options.length
          )
        ];
      }
    );

    iterations++;
  }

  return result;
}

// ============================================================
// HTML -> TEXT
// ============================================================

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
    .replace(
      /<br\s*\/?>/gi,
      "\n"
    )
    .replace(
      /<\/p>/gi,
      "\n\n"
    )
    .replace(
      /<\/div>/gi,
      "\n"
    )
    .replace(
      /<li[^>]*>/gi,
      "\n- "
    )
    .replace(
      /<\/li>/gi,
      ""
    )
    .replace(
      /<[^>]*>/g,
      ""
    )
    .replace(
      /&nbsp;/gi,
      " "
    )
    .replace(
      /&amp;/gi,
      "&"
    )
    .replace(
      /&lt;/gi,
      "<"
    )
    .replace(
      /&gt;/gi,
      ">"
    )
    .replace(
      /&quot;/gi,
      '"'
    )
    .replace(
      /&#39;/gi,
      "'"
    )
    .replace(
      /\n\s*\n/g,
      "\n\n"
    )
    .trim();
}

// ============================================================
// HTML ESCAPE
// ============================================================

function escapeHtml(value) {
  return String(value || "")
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#39;"
    );
}

// ============================================================
// AUTHENTICATION
// ============================================================

app.post(
  "/api/auth",
  (req, res) => {
    const {
      password
    } = req.body || {};

    if (
      password ===
      SITE_PASSWORD
    ) {
      return res.json({
        success: true
      });
    }

    return res.status(401).json({
      success: false,
      message:
        "Incorrect password"
    });
  }
);

// ============================================================
// SMTP VERIFY
// ============================================================

app.post(
  "/api/verify",
  async (req, res) => {
    const {
      email,
      appPassword
    } = req.body || {};

    if (
      !email ||
      !appPassword
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Credentials required"
      });
    }

    const cleanEmail =
      String(email)
        .toLowerCase()
        .trim();

    if (
      !isValidEmail(
        cleanEmail
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid email address"
      });
    }

    try {
      const transporter =
        getTransporter(
          cleanEmail,
          appPassword
        );

      await transporter.verify();

      return res.json({
        success: true,
        message:
          "SMTP verified successfully"
      });
    } catch (error) {
      console.error(
        "SMTP verification failed:",
        error.message
      );

      return res.status(401).json({
        success: false,
        message:
          "Authentication failed. Check App Password."
      });
    }
  }
);

// ============================================================
// SEND STREAM
// ============================================================

app.post(
  "/api/send-stream",
  async (req, res) => {
    const {
      email,
      appPassword,
      senderName,
      subject,
      messageBody,
      recipients
    } = req.body || {};

    /*
     * SAME INPUT FIELDS AS YOUR ORIGINAL CODE
     */

    if (
      !email ||
      !appPassword ||
      !Array.isArray(
        recipients
      ) ||
      recipients.length === 0
    ) {
      res.write(
        `data: ${JSON.stringify({
          success: false,
          error:
            "Missing required fields"
        })}\n\n`
      );

      return res.end();
    }

    const senderEmail =
      String(email)
        .toLowerCase()
        .trim();

    const cleanSenderName =
      String(
        senderName || ""
      )
        .replace(
          /[\r\n"]/g,
          ""
        )
        .trim();

    if (
      !isValidEmail(
        senderEmail
      )
    ) {
      res.write(
        `data: ${JSON.stringify({
          success: false,
          error:
            "Invalid sender email"
        })}\n\n`
      );

      return res.end();
    }

    /*
     * Clean recipients
     *
     * - trim
     * - lowercase
     * - remove invalid addresses
     * - remove duplicates
     */

    const cleanRecipients = [
      ...new Set(
        recipients
          .map(
            (recipient) =>
              String(
                recipient || ""
              )
                .trim()
                .toLowerCase()
          )
          .filter(
            isValidEmail
          )
      )
    ];

    if (
      cleanRecipients.length === 0
    ) {
      res.write(
        `data: ${JSON.stringify({
          success: false,
          error:
            "No valid recipients found"
        })}\n\n`
      );

      return res.end();
    }

    // ========================================================
    // SSE HEADERS
    // ========================================================

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
     * Keep your original global stop mechanism
     * so existing frontend continues to work.
     */

    activeSessions.global_stop =
      false;

    /*
     * Batch reference
     */

    const batchReferenceId =
      createReferenceId();

    res.write(
      `data: ${JSON.stringify({
        type: "start",
        success: true,
        referenceId:
          batchReferenceId,
        total:
          cleanRecipients.length
      })}\n\n`
    );

    try {
      /*
       * Create transporter once.
       */

      const transporter =
        getTransporter(
          senderEmail,
          appPassword
        );

      /*
       * Verify SMTP once.
       */

      await transporter.verify();

      // ======================================================
      // SEND LOOP
      // ======================================================

      for (
        let index = 0;
        index <
        cleanRecipients.length;
        index++
      ) {
        /*
         * STOP CHECK
         */

        if (
          activeSessions.global_stop
        ) {
          res.write(
            `data: ${JSON.stringify({
              success: false,
              error:
                "Stopped by user"
            })}\n\n`
          );

          break;
        }

        const recipient =
          cleanRecipients[index];

        /*
         * SSE keep alive
         */

        res.write(
          ": keep-alive\n\n"
        );

        /*
         * Unique reference ID
         * for THIS email.
         */

        const referenceId =
          createReferenceId();

        try {
          // ==================================================
          // SPINTAX
          // ==================================================

          const spunSubject =
            parseSpintax(
              subject || ""
            );

          const spunBody =
            parseSpintax(
              messageBody || ""
            );

          // ==================================================
          // HTML DETECTION
          // ==================================================

          const isHtml =
            /<[a-z][\s\S]*>/i.test(
              spunBody
            );

          // ==================================================
          // REFERENCE FOOTER
          // ==================================================

          const safeReference =
            escapeHtml(
              referenceId
            );

          const referenceText =
            `\n\nReference ID: ${referenceId}`;

          const referenceHtml = `
<div style="
  margin-top:20px;
  padding-top:10px;
  border-top:1px solid #dddddd;
  color:#777777;
  font-size:11px;
  font-family:Arial,Helvetica,sans-serif;
">
  Reference ID: ${safeReference}
</div>
`;

          // ==================================================
          // MAIL OPTIONS
          // ==================================================

          const mailOptions = {
            from: cleanSenderName
              ? `"${cleanSenderName}" <${senderEmail}>`
              : senderEmail,

            to: recipient,

            subject:
              spunSubject,

            /*
             * Internal reference header.
             */
            headers: {
              "X-Reference-ID":
                referenceId
            }
          };

          // ==================================================
          // HTML + TEXT
          // ==================================================

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

          // ==================================================
          // SEND
          // ==================================================

          await transporter.sendMail(
            mailOptions
          );

          // ==================================================
          // SUCCESS
          // ==================================================

          res.write(
            `data: ${JSON.stringify({
              success: true,
              recipient,
              referenceId,
              index:
                index + 1,
              total:
                cleanRecipients.length
            })}\n\n`
          );
        } catch (error) {
          /*
           * Server log
           */

          console.error(
            `Error sending to ${recipient}:`,
            error.message
          );

          /*
           * Don't expose complete SMTP
           * internals to browser.
           */

          res.write(
            `data: ${JSON.stringify({
              success: false,
              recipient,
              error:
                "Email could not be delivered",
              index:
                index + 1,
              total:
                cleanRecipients.length
            })}\n\n`
          );
        }

        /*
         * Conservative delay.
         *
         * Your original was 100ms.
         * Here it is 3000ms.
         */

        if (
          index <
          cleanRecipients.length - 1
        ) {
          await new Promise(
            (resolve) =>
              setTimeout(
                resolve,
                3000
              )
          );
        }
      }
    } catch (error) {
      console.error(
        "Sending process failed:",
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

    // ========================================================
    // DONE
    // ========================================================

    res.write(
      "data: [DONE]\n\n"
    );

    res.end();
  }
);

// ============================================================
// STOP ROUTE
// ============================================================

app.post(
  "/api/stop",
  (req, res) => {
    activeSessions.global_stop =
      true;

    return res.json({
      success: true,
      message:
        "Stop process registered"
    });
  }
);

// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
  "/api/health",
  (req, res) => {
    return res.json({
      success: true,
      status: "online"
    });
  }
);

// ============================================================
// VERCEL / SERVERLESS
// ============================================================

export default app;
```

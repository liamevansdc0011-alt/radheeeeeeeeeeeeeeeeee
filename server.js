import 'dotenv/config';
import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

// Transporter Configuration
// Standard production approach: Use dedicated SMTP / API provider with SPF/DKIM configured
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: 587,
  secure: false, // TLS via STARTTLS
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  pool: true,
  maxConnections: 5,
  maxMessages: 100
});

// Verify connection configuration on startup
transporter.verify((error, success) => {
  if (error) {
    console.error('SMTP Connection Error:', error);
  } else {
    console.log('Server is ready to send messages safely');
  }
});

/* ==========================================================================
   LEGITIMATE SINGLE / BATCH MAIL ROUTE
   ========================================================================== */
app.post('/api/send-email', async (req, res) => {
  const { to, subject, text, html } = req.body;

  if (!to || !subject || (!text && !html)) {
    return res.status(400).json({ success: false, message: 'Missing required parameters' });
  }

  try {
    const mailOptions = {
      from: `"${process.env.SENDER_NAME || 'Support'}" <${process.env.SMTP_USER}>`,
      to: to, // Recipient address
      subject: subject,
      text: text, // Plain text alternative (Crucial for deliverability)
      html: html
    };

    const info = await transporter.sendMail(mailOptions);
    return res.json({ success: true, messageId: info.messageId });

  } catch (error) {
    console.error('Mail Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

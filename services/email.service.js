const nodemailer = require('nodemailer');

// Email configuration from environment variables
const EMAIL_HOST = process.env.EMAIL_HOST || 'smtp.gmail.com';
const EMAIL_PORT = parseInt(process.env.EMAIL_PORT || '587');
const EMAIL_SECURE = process.env.EMAIL_SECURE === 'true'; // true for 465, false for other ports
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER || 'noreply@comftrip.com';
const EMAIL_ENABLED = process.env.EMAIL_ENABLED !== 'false'; // Default to true if not set

// Create reusable transporter
let transporter = null;

function createTransporter() {
  if (!EMAIL_USER || !EMAIL_PASS) {
    console.warn('[email] EMAIL_USER or EMAIL_PASS not configured. Email sending disabled.');
    return null;
  }

  return nodemailer.createTransport({
    host: EMAIL_HOST,
    port: EMAIL_PORT,
    secure: EMAIL_SECURE, // true for 465, false for other ports
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS,
    },
  });
}

/**
 * Send password reset code email
 * @param {string} to - Recipient email address
 * @param {string} code - 6-digit verification code
 * @param {string} userName - User's name (optional)
 * @returns {Promise<boolean>} - Returns true if email was sent successfully
 */
async function sendPasswordResetCode(to, code, userName = null) {
  if (!EMAIL_ENABLED) {
    console.log(`[email] Email disabled. Would send password reset code to ${to}: ${code}`);
    return false;
  }

  if (!transporter) {
    transporter = createTransporter();
    if (!transporter) {
      console.error('[email] Cannot send email: transporter not configured');
      return false;
    }
  }

  const greeting = userName ? `Hola ${userName},` : 'Hola,';
  
  const mailOptions = {
    from: `"ComfTrip" <${EMAIL_FROM}>`,
    to: to,
    subject: 'Código de recuperación de contraseña - ComfTrip',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #4CAF50; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
          .content { background-color: #f9f9f9; padding: 30px; border-radius: 0 0 5px 5px; }
          .code-box { background-color: #fff; border: 2px dashed #4CAF50; padding: 20px; text-align: center; margin: 20px 0; border-radius: 5px; }
          .code { font-size: 32px; font-weight: bold; color: #4CAF50; letter-spacing: 5px; }
          .footer { text-align: center; margin-top: 20px; color: #666; font-size: 12px; }
          .warning { color: #d32f2f; font-size: 14px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>ComfTrip</h1>
          </div>
          <div class="content">
            <p>${greeting}</p>
            <p>Has solicitado recuperar tu contraseña. Utiliza el siguiente código de verificación:</p>
            <div class="code-box">
              <div class="code">${code}</div>
            </div>
            <p>Este código expirará en <strong>10 minutos</strong>.</p>
            <p class="warning">⚠️ Si no solicitaste este código, ignora este mensaje. Tu cuenta permanecerá segura.</p>
            <p>Saludos,<br>El equipo de ComfTrip</p>
          </div>
          <div class="footer">
            <p>Este es un mensaje automático, por favor no respondas a este correo.</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `
${greeting}

Has solicitado recuperar tu contraseña. Utiliza el siguiente código de verificación:

${code}

Este código expirará en 10 minutos.

⚠️ Si no solicitaste este código, ignora este mensaje. Tu cuenta permanecerá segura.

Saludos,
El equipo de ComfTrip

---
Este es un mensaje automático, por favor no respondas a este correo.
    `.trim(),
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[email] Password reset code sent to ${to}: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error('[email] Error sending password reset email:', error);
    return false;
  }
}

/**
 * Verify email configuration
 * @returns {Promise<boolean>} - Returns true if email is properly configured
 */
async function verifyEmailConfig() {
  if (!EMAIL_ENABLED) {
    console.log('[email] Email service is disabled');
    return false;
  }

  if (!EMAIL_USER || !EMAIL_PASS) {
    console.warn('[email] Email not configured: EMAIL_USER or EMAIL_PASS missing');
    return false;
  }

  if (!transporter) {
    transporter = createTransporter();
    if (!transporter) {
      return false;
    }
  }

  try {
    await transporter.verify();
    console.log('[email] Email service is ready');
    return true;
  } catch (error) {
    console.error('[email] Email service verification failed:', error.message);
    return false;
  }
}

module.exports = {
  sendPasswordResetCode,
  verifyEmailConfig,
  EMAIL_ENABLED,
};


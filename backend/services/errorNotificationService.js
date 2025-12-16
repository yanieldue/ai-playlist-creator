/**
 * Error Notification Service
 * Handles logging critical errors and sending email notifications
 */

const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// Email configuration - using environment variables
const emailConfig = {
  service: process.env.EMAIL_SERVICE || 'gmail',
  user: process.env.EMAIL_USER,
  pass: process.env.EMAIL_PASS,
  to: process.env.DEVELOPER_EMAIL || '11danielyue@gmail.com',
};

// Initialize transporter
let transporter = null;

const initializeTransporter = () => {
  if (emailConfig.user && emailConfig.pass) {
    transporter = nodemailer.createTransport({
      service: emailConfig.service,
      auth: {
        user: emailConfig.user,
        pass: emailConfig.pass,
      },
    });
  }
};

// Log error to file
const logErrorToFile = (errorLog) => {
  try {
    const logsDir = path.join(__dirname, '../logs');
    
    // Create logs directory if it doesn't exist
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const logFileName = path.join(logsDir, `errors-${new Date().toISOString().split('T')[0]}.log`);
    const logEntry = {
      timestamp: new Date().toISOString(),
      category: errorLog.category,
      userMessage: errorLog.userMessage,
      endpoint: errorLog.errorDetails?.endpoint,
      method: errorLog.errorDetails?.method,
      status: errorLog.errorDetails?.status,
      message: errorLog.errorDetails?.message,
      originalError: errorLog.errorDetails?.originalError,
      context: errorLog.context,
    };

    fs.appendFileSync(logFileName, JSON.stringify(logEntry) + '\n');
  } catch (error) {
    console.error('Failed to write error log:', error);
  }
};

// Send error notification email
const sendErrorNotification = async (errorLog) => {
  if (!transporter) {
    console.warn('Email transporter not configured. Skipping email notification.');
    return;
  }

  try {
    const timestamp = new Date(errorLog.timestamp).toLocaleString();
    const htmlContent = `
      <h2>🚨 Critical Error Notification</h2>
      <p><strong>Time:</strong> ${timestamp}</p>
      <p><strong>Category:</strong> ${errorLog.category}</p>
      <p><strong>User Message:</strong> ${errorLog.userMessage}</p>
      
      <h3>Error Details:</h3>
      <ul>
        <li><strong>Endpoint:</strong> ${errorLog.errorDetails?.endpoint || 'N/A'}</li>
        <li><strong>Method:</strong> ${errorLog.errorDetails?.method || 'N/A'}</li>
        <li><strong>Status:</strong> ${errorLog.errorDetails?.status || 'N/A'}</li>
        <li><strong>Message:</strong> ${errorLog.errorDetails?.message || 'N/A'}</li>
        <li><strong>Original Error:</strong> ${errorLog.errorDetails?.originalError || 'N/A'}</li>
      </ul>
      
      <h3>Context:</h3>
      <pre><code>${JSON.stringify(errorLog.context, null, 2)}</code></pre>
      
      <p><em>This error has been logged and requires investigation.</em></p>
    `;

    const mailOptions = {
      from: emailConfig.user,
      to: emailConfig.to,
      subject: `[AI Playlist Creator] Critical Error: ${errorLog.errorDetails?.endpoint || 'Unknown'}`,
      html: htmlContent,
    };

    await transporter.sendMail(mailOptions);
    console.log('Error notification email sent successfully');
  } catch (error) {
    console.error('Failed to send error notification email:', error);
  }
};

// Main function to handle error notifications
const handleCriticalError = async (errorLog) => {
  // Always log to file
  logErrorToFile(errorLog);

  // Send email if configured
  if (emailConfig.user && emailConfig.pass) {
    await sendErrorNotification(errorLog);
  }
};

// Initialize on load
initializeTransporter();

module.exports = {
  handleCriticalError,
  logErrorToFile,
  sendErrorNotification,
};

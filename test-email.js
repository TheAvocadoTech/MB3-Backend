// test-pdf-email.js
const nodemailer = require("nodemailer");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
require("dotenv").config();

async function generateTestPDF() {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument();
      const buffers = [];
      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => resolve(Buffer.concat(buffers)));

      QRCode.toDataURL(
        "https://example.com/visitor/123",
        async (err, qrDataUrl) => {
          if (err) reject(err);

          doc.fontSize(24).text("TEST VISITOR PASS", { align: "center" });
          doc.moveDown();
          doc.fontSize(14).text("Name: John Doe");
          doc.text("Phone: +1234567890");
          doc.text("Purpose: Meeting");
          doc.text(`Valid Until: ${new Date().toLocaleString()}`);
          doc.moveDown();

          const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, "");
          const imageBuffer = Buffer.from(base64Data, "base64");
          doc.image(imageBuffer, { fit: [150, 150], align: "center" });
          doc.moveDown();
          doc
            .fontSize(10)
            .text("Present this QR code at reception", { align: "center" });
          doc.end();
        },
      );
    } catch (error) {
      reject(error);
    }
  });
}

async function sendTestPDFEmail() {
  try {
    console.log("📧 Testing PDF email...");

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.verify();
    console.log("✅ Connection verified");

    console.log("📄 Generating test PDF...");
    const pdfBuffer = await generateTestPDF();
    console.log("✅ PDF generated (size:", pdfBuffer.length, "bytes)");

    const mailOptions = {
      from: `"Visitor System" <${process.env.SMTP_FROM || "sonutech04@gmail.com"}>`,
      to: "sonutech04@gmail.com",
      subject: "✅ Test PDF with QR Code",
      html: `
        <h1>✅ PDF Test Successful!</h1>
        <p>This email contains a test PDF with a QR code.</p>
        <p><strong>PDF Size:</strong> ${(pdfBuffer.length / 1024).toFixed(2)} KB</p>
        <p><strong>Sent at:</strong> ${new Date().toLocaleString()}</p>
        <p>Your QR code email system is working!</p>
      `,
      attachments: [
        {
          filename: "test_visitor_pass.pdf",
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    };

    console.log("📤 Sending email with PDF...");
    const info = await transporter.sendMail(mailOptions);
    console.log("✅ Email sent successfully!");
    console.log("📨 Message ID:", info.messageId);
    console.log("📧 Check your inbox: sonutech04@gmail.com");
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
}

sendTestPDFEmail();

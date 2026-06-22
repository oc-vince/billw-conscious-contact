import type { Context } from "@netlify/functions";
import nodemailer from "nodemailer";

interface FormPayload {
  form_name: string;
  data: Record<string, string>;
  created_at: string;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export default async (req: Request, _context: Context) => {
  const body = (await req.json()) as { payload: FormPayload };
  const payload = body.payload;

  if (payload.form_name !== "contact") {
    return new Response("Ignored: not the contact form", { status: 200 });
  }

  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_USER,
    SMTP_PASS,
    SMTP_SECURE,
    SMTP_FROM,
    SMTP_TO,
  } = process.env;

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !SMTP_FROM || !SMTP_TO) {
    console.error("SMTP environment variables are not fully configured.");
    return new Response("SMTP not configured", { status: 500 });
  }

  const port = Number(SMTP_PORT);
  const secure = SMTP_SECURE
    ? SMTP_SECURE.toLowerCase() === "true"
    : port === 465;

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const data = payload.data || {};
  const fullname = data.fullname || "Unknown";
  const email = data.email || "";
  const phone = data.phone || "";
  const message = data.message || "";

  const textBody = [
    `New contact form submission`,
    ``,
    `Name:    ${fullname}`,
    `Email:   ${email}`,
    `Phone:   ${phone}`,
    ``,
    `Message:`,
    message,
    ``,
    `Submitted: ${payload.created_at}`,
  ].join("\n");

  const htmlBody = `
    <h2>New contact form submission</h2>
    <p><strong>Name:</strong> ${escapeHtml(fullname)}</p>
    <p><strong>Email:</strong> ${escapeHtml(email)}</p>
    <p><strong>Phone:</strong> ${escapeHtml(phone)}</p>
    <p><strong>Message:</strong></p>
    <p>${escapeHtml(message).replace(/\n/g, "<br>")}</p>
    <hr>
    <p style="color:#888;font-size:12px;">Submitted: ${escapeHtml(payload.created_at)}</p>
  `;

  await transporter.sendMail({
    from: SMTP_FROM,
    to: SMTP_TO,
    replyTo: email || undefined,
    subject: `New contact form message from ${fullname}`,
    text: textBody,
    html: htmlBody,
  });

  return new Response("Email sent", { status: 200 });
};

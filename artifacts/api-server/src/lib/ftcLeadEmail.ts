import type { ServiceAutomation } from "./ftcLeadAutomationConfig";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildFtcLeadAcknowledgementEmail(
  firstName: string,
  config: ServiceAutomation,
): { subject: string; html: string; text: string } {
  const safeName = escapeHtml(firstName || "there");
  const safeLabel = escapeHtml(config.label);
  const safePrepare = escapeHtml(config.prepare);
  const safeUrl = escapeHtml(config.actionUrl);
  const safeAction = escapeHtml(config.actionLabel);
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f1f4fa;font-family:Arial,sans-serif;color:#172b4d;">
  <div style="max-width:620px;margin:32px auto;background:#fff;border:1px solid #e1e7f0;border-radius:16px;overflow:hidden;">
    <div style="padding:30px 36px 12px;text-align:center;">
      <img src="https://freeturkishcourse.com/logo.png" width="188" alt="Free Turkish Course" style="display:block;width:188px;max-width:100%;height:auto;border:0;margin:0 auto;">
      <p style="margin:18px 0 6px;color:#ef241c;font-size:12px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;">Free Turkish Course</p>
      <h1 style="margin:0;color:#172b4d;font-family:Georgia,serif;font-size:30px;line-height:1.2;">We received your request</h1>
    </div>
    <div style="padding:24px 42px 38px;font-size:16px;line-height:1.65;">
      <p>Hi ${safeName},</p>
      <p>Thank you for contacting us through Free Turkish Course. We received your <strong>${safeLabel}</strong> enquiry and the relevant team will review it.</p>
      <p>To help us respond faster, please have ${safePrepare} ready. You can reply directly to this email if you would like to add those details.</p>
      <div style="text-align:center;margin:28px 0;"><a href="${safeUrl}" style="display:inline-block;background:#172f57;color:#fff;text-decoration:none;padding:14px 24px;border-radius:9px;font-weight:700;">${safeAction}</a></div>
      <p style="font-size:14px;color:#64748b;">Submitting an enquiry is not a booking or admission confirmation. Availability, price and final conditions will be confirmed separately in writing.</p>
      <p style="margin:24px 0 0;">Best regards,<br><strong>Free Turkish Course</strong></p>
    </div>
    <div style="padding:22px 34px;background:#f8fafc;border-top:1px solid #e1e7f0;text-align:center;color:#7b879d;font-size:12px;line-height:1.55;">
      You are receiving this service message because you submitted an enquiry on freeturkishcourse.com.<br>
      Free Turkish Course is provided by Find And Study.
    </div>
  </div>
</body></html>`;
  const text = `Hi ${firstName || "there"},\n\nThank you for contacting us through Free Turkish Course. We received your ${config.label} enquiry and the relevant team will review it.\n\nTo help us respond faster, please have ${config.prepare} ready. You can reply directly to this email if you would like to add those details.\n\n${config.actionLabel}: ${config.actionUrl}\n\nSubmitting an enquiry is not a booking or admission confirmation. Availability, price and final conditions will be confirmed separately in writing.\n\nBest regards,\nFree Turkish Course\n\nYou are receiving this service message because you submitted an enquiry on freeturkishcourse.com. Free Turkish Course is provided by Find And Study.`;
  return { subject: config.subject, html, text };
}

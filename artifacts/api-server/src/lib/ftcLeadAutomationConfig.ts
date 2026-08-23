export type ServiceAutomation = {
  label: string;
  subject: string;
  taskTitle: string;
  prepare: string;
  actionUrl: string;
  actionLabel: string;
};

export const FTC_LEAD_AUTOMATIONS: Record<string, ServiceAutomation> = {
  "ftc-study": {
    label: "study guidance",
    subject: "We received your study guidance request",
    taskTitle: "Contact new FTC study guidance lead",
    prepare: "your preferred degree level, subject, city, budget and intended start date",
    actionUrl: "https://freeturkishcourse.com/study-in-turkey",
    actionLabel: "Review study guidance",
  },
  "ftc-accommodation": {
    label: "student accommodation",
    subject: "We received your accommodation request",
    taskTitle: "Contact new FTC accommodation lead",
    prepare: "your university or city, move-in date, length of stay and preferred room type",
    actionUrl: "https://freeturkishcourse.com/student-accommodation-turkey",
    actionLabel: "Review accommodation guidance",
  },
  "ftc-transfer": {
    label: "airport transfer",
    subject: "We received your airport transfer request",
    taskTitle: "Contact new FTC airport transfer lead",
    prepare: "your airport, flight number, arrival date and time, passenger count and destination address",
    actionUrl: "https://freeturkishcourse.com/istanbul-airport-transfer",
    actionLabel: "Review transfer guidance",
  },
};

export function getFtcAutomationForSource(source: unknown): ServiceAutomation | null {
  const value = String(source || "").toLowerCase();
  return FTC_LEAD_AUTOMATIONS[value.replace(/^embed:/, "")] || null;
}

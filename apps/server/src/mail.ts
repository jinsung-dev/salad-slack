import { createTransport } from "nodemailer";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Delivers one message or throws. */
export type Mailer = (message: MailMessage) => Promise<void>;

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** The From header; defaults to the account. */
  from: string;
}

/** Sends through an SMTP account, e.g. a Google Workspace user with an app password on smtp.gmail.com:465. */
export function smtpMailer(config: SmtpConfig): Mailer {
  const transport = createTransport({
    host: config.host,
    port: config.port,
    // Port 465 speaks TLS from the start; others upgrade with STARTTLS, which is then required.
    secure: config.port === 465,
    requireTLS: config.port !== 465,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return async ({ to, subject, text }) => {
    await transport.sendMail({ from: config.from, to, subject, text });
  };
}

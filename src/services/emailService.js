import nodemailer from 'nodemailer';

let transporter;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.MAIL_HOST || !process.env.MAIL_FROM) {
    throw new Error('Falta configurar MAIL_HOST o MAIL_FROM.');
  }

  const port = Number(process.env.MAIL_PORT) || 587;
  transporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port,
    secure: port === 465,
    auth: process.env.MAIL_USER
      ? { user: process.env.MAIL_USER, pass: process.env.MAIL_PASSWORD }
      : undefined,
  });
  return transporter;
}

export async function sendLoginEmail(user, code) {
  const baseUrl = (process.env.APP_URL || 'http://localhost:4200').replace(/\/+$/, '');
  const loginUrl = `${baseUrl}/invitacion/${code}`;
  console.log('Login invitation URL:', loginUrl);
  // if (process.env.MAIL_HOST && process.env.MAIL_FROM) {
  //   await getTransporter().sendMail({
  //     from: process.env.MAIL_FROM,
  //     to: user.email,
  //     subject: 'Acceso a Holiday Tracker',
  //     text: `Hola ${user.nombre} ${user.apellidos},\n\nUsa este enlace para iniciar sesión. El código es de un solo uso:\n${loginUrl}\n\nSi no esperabas este correo, puedes ignorarlo.`,
  //   });
  // }
}

export async function sendSessionResetVerificationEmail(user, numericCode) {
  console.log(`Código numérico de verificación para ${user.email}: ${numericCode}`);
  // if (process.env.MAIL_HOST && process.env.MAIL_FROM) {
  //   await getTransporter().sendMail({
  //     from: process.env.MAIL_FROM,
  //     to: user.email,
  //     subject: 'Código de verificación para reseteo de sesión - Holiday Tracker',
  //     text: `Hola ${user.nombre} ${user.apellidos},\n\nHemos recibido una solicitud para resetear y volver a solicitar tu sesión en Holiday Tracker.\n\nIntroduce este código numérico de 6 dígitos para confirmar la solicitud (caduca en 10 minutos):\n${numericCode}\n\nSi no has solicitado este cambio, ignora este correo: tu sesión actual no se modificará hasta que se introduzca este código.`,
  //   });
  // }
}

export async function notifyAdminSessionRequest(user) {
  if (!process.env.ADMIN_EMAIL) throw new Error('Falta configurar ADMIN_EMAIL.');
  await getTransporter().sendMail({
    from: process.env.MAIL_FROM,
    to: process.env.ADMIN_EMAIL,
    subject: 'Solicitud de nueva sesión',
    text: `${user.nombre} ${user.apellidos} (${user.email}) ha solicitado una nueva sesión.`,
  });
}

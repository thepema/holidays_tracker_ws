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
  const loginUrl = new URL('/login', process.env.APP_URL || 'http://localhost:4200');
  loginUrl.searchParams.set('code', code);
  await getTransporter().sendMail({
    from: process.env.MAIL_FROM,
    to: user.email,
    subject: 'Acceso a Holiday Tracker',
    text: `Hola ${user.nombre} ${user.apellidos},\n\nUsa este enlace para iniciar sesión. El código es de un solo uso:\n${loginUrl}\n\nSi no esperabas este correo, puedes ignorarlo.`,
  });
}

export async function sendRecoveryEmail(user, recoveryCode) {
  await getTransporter().sendMail({
    from: process.env.MAIL_FROM,
    to: user.email,
    subject: 'Código de recuperación de Holiday Tracker',
    text: `Hola ${user.nombre} ${user.apellidos},\n\nTu nuevo código de recuperación es:\n${recoveryCode}\n\nGuárdalo en un lugar seguro. Solo se puede usar una vez. Si no solicitaste esta recuperación, contacta con el administrador.`,
  });
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

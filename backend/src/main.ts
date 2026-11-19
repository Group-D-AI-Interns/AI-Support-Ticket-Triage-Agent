import { createTicketApp } from './modules/tickets/api.js';

const port = Number(process.env.PORT ?? '8000');
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const app = createTicketApp();
app.listen(port, () => {
  console.info(`AI Support Ticket Triage Agent API listening on port ${port}.`);
});

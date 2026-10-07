// Print a token for the local network's unsafe auth service, for tools that
// read LEDGER_TOKEN. Only valid on the throwaway local network.
import { localToken } from './ledger-users.mjs';
process.stdout.write(localToken(process.argv[2] || 'ledger-api-user', 12 * 3600));

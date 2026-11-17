// Stands in for the Bob CLI: reports how it was launched, so the real spawn path can be tested without a key.
import { readdirSync } from 'node:fs';
const argv = process.argv.slice(2);
console.log(JSON.stringify({
  type: 'probe',
  argv,
  envKeys: Object.keys(process.env).filter((key) => !/^(PATH|Path|SystemRoot|SYSTEMROOT|TEMP|TMP|USERPROFILE|HOME|LANG|BOB_API_KEY|COMSPEC|PATHEXT|WINDIR|SystemDrive)$/i.test(key)).sort(),
  hasKey: Boolean(process.env.BOB_API_KEY),
  cwd: process.cwd(),
  cwdFiles: readdirSync(process.cwd())
}));
console.log('not json, ignored');
console.log(JSON.stringify({ type: 'result', status: 'success', last_message: 'ok' }));

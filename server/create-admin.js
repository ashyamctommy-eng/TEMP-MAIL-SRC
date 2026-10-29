'use strict';

/**
 * Create or reset an admin account.
 *   node server/create-admin.js <username> <password>
 * With no arguments it prompts on a TTY.
 */

const readline = require('readline');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

function ask(question, { silent = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (silent) {
      const onData = (char) => {
        if (['\n', '\r', '\u0004'].includes(char.toString())) {
          process.stdin.removeListener('data', onData);
        } else {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
          process.stdout.write(question + '*'.repeat(rl.line.length));
        }
      };
      process.stdin.on('data', onData);
    }
    rl.question(question, (answer) => {
      rl.close();
      if (silent) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function main() {
  let [username, password] = process.argv.slice(2);

  if (!username) username = await ask('Admin username: ');
  if (!password) password = await ask('Admin password: ', { silent: true });

  if (!username || !/^[a-zA-Z0-9._-]{3,40}$/.test(username)) {
    console.error('Username must be 3-40 characters (letters, numbers, . _ -).');
    process.exit(1);
  }
  if (!password || password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  const existing = db.prepare('SELECT * FROM admins WHERE username = ? COLLATE NOCASE').get(username);

  if (existing) {
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, existing.id);
    db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(existing.id);
    console.log(`Password reset for "${existing.username}". All sessions signed out.`);
  } else {
    db.prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)')
      .run(username, hash, Date.now());
    console.log(`Admin "${username}" created.`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

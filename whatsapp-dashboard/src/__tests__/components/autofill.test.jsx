import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { render, screen } from '@testing-library/react';
import PageHeader from '../../components/PageHeader';

// Browser autofill guard. Chrome's password manager ignores autocomplete="off"
// for saved logins: it filled a saved phone number into search boxes and a
// saved password into User Management's "new password" fields (so a reset
// could silently set someone's password to the admin's own). These pin the
// fixes so a new search box or password field cannot bring it back.

const SRC = join(__dirname, '..', '..');
function jsxFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : jsxFiles(p);
    return p.endsWith('.jsx') ? [p] : [];
  });
}
// Every <input …> element's source text (up to its closing "/>").
function inputs(source) {
  return [...source.matchAll(/<input\b[\s\S]*?\/>/g)].map((m) => m[0]);
}

describe('search boxes are type="search" (never filled with a saved login)', () => {
  it('the shared page header', () => {
    render(<PageHeader title="Orders" search="" onSearch={() => {}} searchPlaceholder="Search" />);
    const box = screen.getByRole('searchbox');
    expect(box.getAttribute('autocomplete')).toBe('off');
    expect(box.getAttribute('data-lpignore')).toBe('true');
    expect(box.getAttribute('data-1p-ignore')).toBe('true');
  });

  it('every input bound to search text, anywhere in the app', () => {
    const offenders = [];
    for (const file of jsxFiles(SRC)) {
      for (const el of inputs(readFileSync(file, 'utf8'))) {
        if (/value=\{(search|query|searchTerm|filterText)\b/.test(el) && !/type="search"/.test(el)) {
          offenders.push(`${relative(SRC, file)}: ${el.slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('password fields say what they are', () => {
  it('User Management never lets the browser put a saved password into a new one', () => {
    const src = readFileSync(join(SRC, 'pages', 'Users.jsx'), 'utf8');
    const pw = inputs(src).filter((el) => /type="password"/.test(el));
    expect(pw.length).toBeGreaterThan(0);
    for (const el of pw) expect(el).toMatch(/autoComplete="new-password"/);
  });

  it('the login page labels its username and password, so the right pair is saved', () => {
    const src = readFileSync(join(SRC, 'pages', 'Login.jsx'), 'utf8');
    expect(src).toMatch(/autoComplete="username"/);
    expect(src).toMatch(/autoComplete="current-password"/);
  });

  it('Connect my phone gives its password a (hidden) username instead of letting the browser pick a search box', () => {
    const src = readFileSync(join(SRC, 'components', 'ConnectPhoneModal.jsx'), 'utf8');
    const user = inputs(src).find((el) => /autoComplete="username"/.test(el));
    expect(user).toBeTruthy();
    expect(user).toMatch(/hidden/);
  });
});

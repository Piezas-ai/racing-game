/** Sign in / register with username + password. */
import { useState, type FormEvent } from 'react';
import { api, type User } from '../api';

interface Props {
  onAuthed: (user: User) => void;
  joinCode: string | null;
}

export function Auth({ onAuthed, joinCode }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const user =
        mode === 'login'
          ? await api.login(username.trim(), password)
          : await api.register(username.trim(), password);
      onAuthed(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <div className="card auth-card">
        <h1 className="logo">🏁 Vancouver Road Simulator</h1>
        <p className="credit">by Jasper, Skyler, Dad and Fable</p>
        <p className="muted">2-player online racing — lucky blocks, jump scares, spikes &amp; traps.</p>
        {joinCode && (
          <p className="join-banner">
            You've been invited to race <strong>#{joinCode}</strong> — sign in to join!
          </p>
        )}
        <div className="tabs">
          <button className={mode === 'login' ? 'tab active' : 'tab'} onClick={() => setMode('login')}>
            Sign in
          </button>
          <button className={mode === 'register' ? 'tab active' : 'tab'} onClick={() => setMode('register')}>
            Create account
          </button>
        </div>
        <form onSubmit={submit}>
          <input
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
          />
          <input
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
          {error && <p className="error">{error}</p>}
          <button className="btn btn-primary" type="submit" disabled={busy || !username || !password}>
            {busy ? '…' : mode === 'login' ? 'Sign in' : 'Sign up & play'}
          </button>
        </form>
      </div>
    </div>
  );
}

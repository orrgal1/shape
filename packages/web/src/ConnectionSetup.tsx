import { useState, type FormEvent } from "react";
import { useApp } from "./store.ts";
import { getBridgeEndpoint, setBridgeToken } from "./ws.ts";

export function ConnectionSetup() {
  const conn = useApp((state) => state.conn);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (conn === "live" || conn === "mock") return null;

  const endpoint = getBridgeEndpoint();
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setError(null);
    try {
      setBridgeToken(token);
    } catch {
      setError(
        "Could not apply the token safely. Use secure WSS (or a loopback/SSH tunnel) and make sure browser storage is available, then retry.",
      );
    } finally {
      setToken("");
    }
  };

  return (
    <section className="connection-setup" aria-labelledby="connection-setup-title">
      <p className="connection-setup-kicker">connection</p>
      <h2 id="connection-setup-title">Canvas is not connected</h2>
      <p className="connection-setup-body">
        Check that the server is available, or enter its access token to connect.
      </p>
      <p className="connection-setup-destination">
        <span>destination</span>
        <code>{endpoint}</code>
      </p>
      <form className="connection-setup-form" onSubmit={submit}>
        <label htmlFor="bridge-access-token">Access token</label>
        <div className="connection-setup-actions">
          <input
            id="bridge-access-token"
            type="password"
            value={token}
            onChange={(event) => {
              setToken(event.currentTarget.value);
              setError(null);
            }}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit">Connect / retry</button>
        </div>
        <p className="connection-setup-note">Leave blank to clear a saved token and retry.</p>
        {error === null ? null : (
          <p className="connection-setup-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}

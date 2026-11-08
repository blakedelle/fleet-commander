import { useEffect, useState } from "react";

interface Props {
  connected: boolean;
  mode: string;
}

export default function Header({ connected, mode }: Props) {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      <header className="header">
        <h1>FLEET COMMANDER AI</h1>
        <div className="header-right">
          <span className="clock">{now.toLocaleTimeString()}</span>
          <span className="mode-pill">{mode}</span>
          <div className={connected ? "conn on" : "conn"}>
            <span className="conn-dot" />
            {connected ? "CONNECTED" : "DISCONNECTED"}
          </div>
        </div>
      </header>
      {!connected && (
        <div className="conn-lost">
          ⚠ CONNECTION LOST: data on screen may be out of date
        </div>
      )}
    </>
  );
}
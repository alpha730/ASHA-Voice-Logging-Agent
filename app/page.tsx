import Link from "next/link";

export default function Home() {
  return (
    <div className="stack">
      <div>
        <h1>Speak the visit. Skip the register.</h1>
        <p className="muted">
          ASHA and Anganwadi workers talk through a home visit in Hindi, English, or both. The agent turns it into a
          structured record and a supervisor sees it immediately.
        </p>
      </div>
      <div className="grid">
        <Link href="/record" className="card" style={{ textDecoration: "none", color: "inherit" }}>
          <h2>Record a visit</h2>
          <p className="muted">For health workers. Tap, talk, answer any follow-up question.</p>
        </Link>
        <Link href="/dashboard" className="card" style={{ textDecoration: "none", color: "inherit" }}>
          <h2>Supervisor dashboard</h2>
          <p className="muted">Every logged visit, newest first, with the original transcript.</p>
        </Link>
      </div>
    </div>
  );
}

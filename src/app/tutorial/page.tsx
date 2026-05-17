"use client";

import Link from "next/link";

export default function TutorialPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          How to use this app
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A 3-minute walkthrough. Read top-to-bottom or jump to a section.
        </p>
      </header>

      <nav className="mb-10 rounded-md border border-border bg-muted/30 p-3 text-sm">
        <ul className="space-y-1">
          <li>
            <a href="#intro" className="text-primary hover:underline">
              What this app does
            </a>
          </li>
          <li>
            <a href="#quick-start" className="text-primary hover:underline">
              Your first 5 minutes
            </a>
          </li>
          <li>
            <a href="#methodology" className="text-primary hover:underline">
              The methodology
            </a>
          </li>
          <li>
            <a href="#coming-soon" className="text-primary hover:underline">
              Coming soon
            </a>
          </li>
          <li>
            <a href="#troubleshooting" className="text-primary hover:underline">
              Troubleshooting
            </a>
          </li>
        </ul>
      </nav>

      <Section id="intro" title="What this app does">
        <p>
          This is your local YouTube research and ideation HQ. Everything runs
          on your Mac.
        </p>
        <p>
          No data leaves your laptop unless you send it to an external API
          (Claude, YouTube Data, Deepgram).
        </p>
        <p>
          The app&apos;s job: find what&apos;s working for your competitors,
          validate topics across the niche, and generate channel-specific video
          ideas.
        </p>
      </Section>

      <Section id="quick-start" title="Your first 5 minutes">
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            Open{" "}
            <Link href="/settings/integrations" className="text-primary hover:underline">
              Integrations
            </Link>{" "}
            → paste your Claude and YouTube Data API keys.
          </li>
          <li>
            Open{" "}
            <Link href="/channel-info" className="text-primary hover:underline">
              Channel Info
            </Link>{" "}
            → fill in niche, positioning, audience, voice — or click
            &ldquo;Analyze with AI&rdquo; to auto-populate from recent
            videos.
          </li>
          <li>
            Open{" "}
            <Link href="/competitors" className="text-primary hover:underline">
              Competitors
            </Link>{" "}
            → add competitor channels and tag each as Authority, Breakthrough,
            Adjacent, or Far.
          </li>
          <li>
            Open{" "}
            <Link href="/outliers" className="text-primary hover:underline">
              Outliers
            </Link>{" "}
            → competitor videos that beat their own channel&apos;s median by
            2× or more. Library tab + Patterns tab (auto-extracted title
            format library).
          </li>
          <li>
            Open{" "}
            <Link href="/chat" className="text-primary hover:underline">
              AI Chat
            </Link>{" "}
            → ask the agent &ldquo;Generate 5 ideas from my current outliers&rdquo;
            or &ldquo;Find topic gaps.&rdquo; This is the central ideation
            surface — every methodology lens lives here.
          </li>
        </ol>
      </Section>

      <Section id="methodology" title="The methodology">
        <ul className="space-y-2 pl-5">
          <li className="list-disc">
            <strong>Outliers are relative.</strong> A video is an outlier if it
            beats its own channel&apos;s median by 2× or more (60-day window) —
            not because it crossed some absolute view threshold.
          </li>
          <li className="list-disc">
            <strong>Validate topics across channels and time.</strong> A single
            channel&apos;s success doesn&apos;t prove a topic — three different
            channels hitting it across different months does.
          </li>
          <li className="list-disc">
            <strong>Title formats are patterns, not literal titles.</strong>{" "}
            Save the structure (<code className="rounded bg-muted px-1 py-0.5 text-xs">[Counterintuitive claim] about [Familiar topic]</code>),
            not the words. Formats shift every few months.
          </li>
          <li className="list-disc">
            <strong>The 90/10 rule for thumbnails.</strong> 90% of your
            thumbnail should be the proven outlier format you took inspiration
            from. 10% is your channel&apos;s own branding.
          </li>
          <li className="list-disc">
            <strong>Daily research is non-negotiable.</strong> Spot new
            competitors, new title structures, and topic claims before you
            waste a week producing something that&apos;s already been taken.
          </li>
        </ul>
        <p className="mt-4 text-xs text-muted-foreground">
          Full methodology in <code className="rounded bg-muted px-1 py-0.5">MENTOR_METHOD.md</code> at the project root.
        </p>
      </Section>

      <Section id="coming-soon" title="Coming soon">
        <ul className="space-y-3 pl-5">
          <li className="list-disc">
            <strong>Topic Validator.</strong> Paste a topic, the app checks how
            many different channels covered it and across what time periods.
            Auto-flags traps: single-channel only, event-spike, pre-2020 boost,
            evergreen-confirmed.
          </li>
          <li className="list-disc">
            <strong>Daily Market Watch.</strong> Runs every morning. Reports
            new outliers, emerging title structures, new competitors blowing
            up, and topic conflicts (a competitor uploaded something you had
            planned).
          </li>
        </ul>
      </Section>

      <Section id="troubleshooting" title="Troubleshooting">
        <div className="space-y-4">
          <div>
            <div className="font-medium">The app forgot my keys</div>
            <p className="text-sm text-muted-foreground">
              Confirm the project folder is NOT inside iCloud Drive, Dropbox,
              or OneDrive. Those services corrupt the SQLite database.
            </p>
          </div>
          <div>
            <div className="font-medium">Port 3000 already in use</div>
            <p className="text-sm text-muted-foreground">
              Quit the other app, or start this one on a different port:{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                npm run dev -- -p 3001
              </code>
              .
            </p>
          </div>
          <div>
            <div className="font-medium">App won&apos;t start at all</div>
            <p className="text-sm text-muted-foreground">
              Re-run{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                install.command
              </code>{" "}
              from the project folder. If the issue persists, screenshot the
              terminal output.
            </p>
          </div>
        </div>
      </Section>
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mb-10 scroll-mt-6">
      <h2 className="mb-4 border-b border-border pb-2 text-xl font-semibold tracking-tight">
        {title}
      </h2>
      <div className="space-y-3 text-sm leading-relaxed text-foreground/90">
        {children}
      </div>
    </section>
  );
}

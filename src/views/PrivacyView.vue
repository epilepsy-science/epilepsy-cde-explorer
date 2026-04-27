<script setup lang="ts">
const lastUpdated = '2026-04-27';
</script>

<template>
  <article class="privacy">
    <header class="privacy__head page-header">
      <h1>Privacy</h1>
      <p class="lede">
        What this site collects and why. Last updated {{ lastUpdated }}.
      </p>
    </header>

    <section>
      <h2>The short version</h2>
      <p>
        This dashboard is a research tool. We collect aggregate, anonymous
        usage analytics so we can improve the experience, and we collect a
        verified email address only for reviewers who choose to submit
        classifications. Nothing on this site is sold, shared with
        third-party advertisers, or used to build a profile of you outside
        the context of CDE review.
      </p>
    </section>

    <section>
      <h2>Analytics — Google Analytics 4</h2>
      <p>
        We use Google Analytics 4 to understand how researchers navigate
        the site so we can spot rough edges and prioritize improvements.
        GA sets a small cookie (<code>_ga</code>) and records:
      </p>
      <ul>
        <li>The pages you visit and how long you spend on each.</li>
        <li>Your approximate location, derived from a truncated (anonymized) IP address. The full IP is never stored.</li>
        <li>Your device type, operating system, and browser.</li>
        <li>The site or search engine that referred you here.</li>
      </ul>
      <p>
        We do <strong>not</strong> send any of the following to Google
        Analytics:
      </p>
      <ul>
        <li>Your email address or any other identifier you give us at sign-in.</li>
        <li>The contents of any review you submit (tier picks, comments, flags).</li>
        <li>Your authentication tokens.</li>
      </ul>
      <h3>Opting out of analytics</h3>
      <p>
        You can opt out at any time by:
      </p>
      <ul>
        <li>
          Installing
          <a href="https://tools.google.com/dlpage/gaoptout" target="_blank" rel="noopener noreferrer">
            Google's official opt-out browser add-on
          </a>
          — works across every site that uses GA.
        </li>
        <li>
          Clearing the <code>_ga</code> cookie in your browser's site
          settings for <code>cde.epilepsy.science</code>.
        </li>
        <li>
          Enabling the "Do Not Track" setting in your browser. We honor
          DNT signals when present.
        </li>
      </ul>
    </section>

    <section>
      <h2>Reviewer accounts</h2>
      <p>
        If you choose to participate in the CDE review process, you'll
        provide an email address to receive a one-time sign-in code. We
        store:
      </p>
      <ul>
        <li>Your verified email address (so we know which classifications came from you).</li>
        <li>Your name and stated areas of expertise (so panel reports can attribute opinions appropriately).</li>
        <li>An optional LinkedIn URL you provide on your profile.</li>
        <li>The classifications, comments, and flags you submit.</li>
      </ul>
      <p>
        Reviewer data lives in a Pennsieve-managed AWS database in the
        United States. We do not share it with Google, advertisers, or
        any third party other than the panel reviewing the consensus
        classifications.
      </p>
      <p>
        You can request deletion of your reviewer record at any time —
        the "Delete account" action on the Review page wipes your
        profile, all your submitted reviews, and the entire revision
        history server-side. The action is immediate and irreversible.
      </p>
    </section>

    <section>
      <h2>Cookies</h2>
      <p>
        This site sets:
      </p>
      <ul>
        <li>
          <strong><code>_ga</code></strong> and a few related GA cookies
          (<code>_ga_&lt;property-id&gt;</code>) — analytics, ~13 months.
        </li>
        <li>
          <strong>localStorage</strong> entries for your sign-in token
          and any custom CRFs you've assembled. These never leave your
          browser.
        </li>
      </ul>
    </section>

    <section>
      <h2>Funding and operating context</h2>
      <p>
        This work is funded by the U.S. National Institutes of Health
        (U24NS134536, 3U24NS134536) and the Department of Defense
        (EP240074), and operated by the University of Pennsylvania on
        the Pennsieve platform. The site exists for non-commercial,
        research-only purposes.
      </p>
    </section>

    <section>
      <h2>Contact</h2>
      <p>
        Questions about your data or this notice:
        <a href="mailto:support@epilepsy.science">support@epilepsy.science</a>.
      </p>
    </section>
  </article>
</template>

<style lang="scss" scoped>
.privacy {
  max-width: 760px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  font-size: 14px;
  line-height: 1.6;
  color: $gray_6;

  &__head h1 {
    margin-bottom: 0.25rem;
  }

  section h2 {
    font-size: 18px;
    margin: 0 0 0.5rem;
    color: $gray_6;
  }

  section h3 {
    font-size: 14px;
    margin: 0.75rem 0 0.25rem;
    color: $gray_5;
  }

  section p {
    margin: 0 0 0.75rem;
  }

  section ul {
    margin: 0 0 0.75rem;
    padding-left: 1.25rem;

    li {
      margin-bottom: 0.25rem;
    }
  }

  code {
    background: $gray_1;
    padding: 1px 6px;
    border-radius: 2px;
    font-size: 90%;
  }

  a {
    color: $es-primary-color;

    &:hover {
      text-decoration: underline;
    }
  }
}
</style>

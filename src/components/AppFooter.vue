<script setup lang="ts">
import pennsieveLogo from '@/assets/pennsieve-logo.svg';

const REPO_URL = 'https://github.com/epilepsy-science/epilepsy-cde-explorer';
const CONTACT_EMAIL = 'support@epilepsy.science';
const FUNDING = 'Funded by NIH (U24NS134536, 3U24NS134536) and DoD (EP240074).';

const year = new Date().getFullYear();
</script>

<template>
  <footer class="app-footer">
    <div class="app-footer__row">
      <!-- Attribution -->
      <a
        class="app-footer__powered"
        href="https://pennsieve.io"
        target="_blank"
        rel="noopener noreferrer"
      >
        <span class="app-footer__powered-label">Powered by</span>
        <img :src="pennsieveLogo" alt="Pennsieve" class="app-footer__logo" />
      </a>

      <!-- Funding -->
      <div class="app-footer__funding">
        {{ FUNDING }}
      </div>

      <!-- Links -->
      <nav class="app-footer__links" aria-label="Footer">
        <a :href="`mailto:${CONTACT_EMAIL}`">Contact</a>
        <span class="app-footer__sep" aria-hidden="true">·</span>
        <a :href="REPO_URL" target="_blank" rel="noopener noreferrer">Source</a>
        <span class="app-footer__sep" aria-hidden="true">·</span>
        <router-link to="/privacy">Privacy</router-link>
      </nav>

      <!-- Copyright -->
      <div class="app-footer__copyright">© {{ year }} University of Pennsylvania</div>
    </div>

    <div class="app-footer__disclaimer subtle">
      Research use only — not intended for clinical decision-making.
    </div>
  </footer>
</template>

<style lang="scss" scoped>
.app-footer {
  border-top: 1px solid $lineColor1;
  background: $gray_1;
  padding: 14px 1.5rem 16px;
  font-size: 12px;
  color: $gray_5;
  display: flex;
  flex-direction: column;
  gap: 6px;

  &__row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px 18px;
  }

  &__powered {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-decoration: none;
    color: inherit;

    &:hover {
      color: $gray_6;
    }
  }

  &__powered-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: $gray_4;
  }

  &__logo {
    height: 18px;
    width: auto;
    display: block;
    // Crush the colored Pennsieve mark to solid black, then mute slightly
    // so the footer attribution doesn't compete with page content.
    filter: brightness(0);
    opacity: 0.65;
  }

  &__funding {
    color: $gray_5;
  }

  &__links {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;

    a {
      color: $gray_5;
      text-decoration: none;

      &:hover {
        color: $es-primary-color;
        text-decoration: underline;
      }
    }
  }

  &__sep {
    color: $gray_3;
  }

  &__privacy {
    color: $gray_4;
    font-size: 11px;
  }

  &__copyright {
    color: $gray_4;
    font-size: 11px;
  }

  &__disclaimer {
    font-size: 11px;
    text-align: center;
  }
}
</style>

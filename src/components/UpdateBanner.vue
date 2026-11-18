<script setup>
// Shown when a newer build of the app has been deployed. Reload fetches the new code from the network.
import { updateAvailable, reloadApp } from '../utils/useUpdateCheck.js';
</script>

<template>
  <div v-if="updateAvailable" class="banner" role="status">
    <span class="banner__icon"><svg class="icon" aria-hidden="true"><use href="#i-info" /></svg></span>
    <div class="banner__body">
      <div class="banner__title">New version available</div>
      <div class="banner__text">Reload to get the latest changes.</div>
    </div>
    <button type="button" class="banner__action btn btn--primary btn--sm" @click="reloadApp">Reload</button>
  </div>
</template>

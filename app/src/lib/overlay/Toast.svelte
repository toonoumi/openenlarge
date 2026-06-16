<script lang="ts">
  import { toast } from "$lib/toast";
  import { fly, fade } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
</script>

{#if $toast}
  {#key $toast.id}
    <div class="toast" in:fly={{ y: 12, duration: 200, easing: cubicOut }} out:fade={{ duration: 160 }}>
      {$toast.msg}
    </div>
  {/key}
{/if}

<style>
  .toast {
    position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
    z-index: 80; pointer-events: none;
    background: var(--glass-bg); border: 1px solid var(--glass-brd);
    backdrop-filter: blur(22px) saturate(140%); -webkit-backdrop-filter: blur(22px) saturate(140%);
    color: var(--text); padding: 10px 16px; border-radius: 10px; font-size: 13px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
  }
</style>

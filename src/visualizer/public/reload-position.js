(function attachReloadPosition(root) {
  function normalizeLoadOptions(optionsOrPreserve = false) {
    if (typeof optionsOrPreserve === 'boolean') {
      return { preservePosition: optionsOrPreserve, preferLatest: false };
    }

    return {
      preservePosition: Boolean(optionsOrPreserve?.preservePosition),
      preferLatest: Boolean(optionsOrPreserve?.preferLatest)
    };
  }

  function resolveTargetIndex({ total, options, previousIndex = null, previousTotal = null, storedIndex = null }) {
    if (total <= 0) return 0;

    if (options.preservePosition && previousIndex !== null) {
      const wasAtLatest = previousTotal !== null && previousIndex >= Math.max(0, previousTotal - 1);
      return wasAtLatest ? total - 1 : Math.min(previousIndex, total - 1);
    }

    if (options.preferLatest) {
      return total - 1;
    }

    return Math.min(storedIndex ?? 0, total - 1);
  }

  root.CCLensReloadPosition = {
    normalizeLoadOptions,
    resolveTargetIndex
  };
})(typeof window !== 'undefined' ? window : globalThis);

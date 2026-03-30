export default defineNuxtPlugin({
  name: "twoslash-popper-ids",
  enforce: "post",
  setup(nuxtApp) {
    let nextId = 0;

    function patchFloatingComponent(name: string) {
      const component = nuxtApp.vueApp.component(name) as
        | {
            components?: {
              Popper?: {
                extends?: {
                  data?: () => Record<string, unknown>;
                  __docsPatchedIds?: boolean;
                };
              };
            };
          }
        | undefined;

      const popper = component?.components?.Popper?.extends;

      if (!popper || popper.__docsPatchedIds) {
        return;
      }

      const originalData = popper.data;

      popper.data = function patchedPopperData() {
        const state = (originalData?.call(this) ?? {}) as Record<string, unknown>;
        state.randomId = `popper_docs_${nextId++}`;
        return state;
      };

      popper.__docsPatchedIds = true;
    }

    patchFloatingComponent("VMenu");
    patchFloatingComponent("VDropdown");
    patchFloatingComponent("VTooltip");
  },
});

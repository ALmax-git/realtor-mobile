import Alpine from "alpinejs";
import { Auth } from "@almaxcloud/core-x";
function Realtor() {
  return {
    view: "loading",
    mode: "home",
    loading_progress: 0,
    is_loading: true,
    ...Auth(),
  };
}
Alpine.data("Realtor", Realtor);

window.Alpine = Alpine;

Alpine.start();

{pkgs}: {
  deps = [
    pkgs.ghostscript
    pkgs.chromium
    pkgs.xorg.libxcb
    pkgs.xorg.libXrandr
    pkgs.xorg.libXfixes
    pkgs.xorg.libXext
    pkgs.xorg.libXdamage
    pkgs.xorg.libXcomposite
    pkgs.xorg.libX11
    pkgs.expat
    pkgs.cairo
    pkgs.pango
    pkgs.mesa
    pkgs.alsa-lib
    pkgs.libxkbcommon
    pkgs.libdrm
    pkgs.dbus
    pkgs.cups
    pkgs.at-spi2-atk
    pkgs.atk
    pkgs.nspr
    pkgs.nss
    pkgs.glib
  ];
}

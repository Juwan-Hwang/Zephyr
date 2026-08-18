class Zephyr < Formula
  desc "A modern, lightweight Mihomo GUI client"
  homepage "https://github.com/Juwan-Hwang/Zephyr"
  version "2.4.3"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/Juwan-Hwang/Zephyr/releases/download/v#{version}/Zephyr_#{version}_aarch64-full.dmg"
      sha256 "bc4d35240947aacda2d4d66237c90a28fcb5a78455503a7480cfacbcde7bb0c9"

      def install
        app = "Zephyr.app"
        prefix.install app
        bin.write_exec_script "#{prefix}/#{app}/Contents/MacOS/Zephyr"
      end
    else
      url "https://github.com/Juwan-Hwang/Zephyr/releases/download/v#{version}/Zephyr_#{version}_x64-full.dmg"
      sha256 "f7798363aeec9be36e788998da2bbf5beae7c3bc5e9334237f8842e5b7c7b802"

      def install
        app = "Zephyr.app"
        prefix.install app
        bin.write_exec_script "#{prefix}/#{app}/Contents/MacOS/Zephyr"
      end
    end
  end

  on_linux do
    if Hardware::CPU.arm? && Hardware::CPU.is_64_bit?
      url "https://github.com/Juwan-Hwang/Zephyr/releases/download/v#{version}/Zephyr-linux-arm64-portable.tar.gz"
      sha256 "604408f849390319f4ca256a876a9effd869a16cf23f84cfc40e3eb594e7cc85"

      def install
        bin.install "Zephyr" => "zephyr"
        pkgshare.install Dir["core/*"] if Dir.exist?("core")
      end
    else
      url "https://github.com/Juwan-Hwang/Zephyr/releases/download/v#{version}/Zephyr-linux-x64-portable.tar.gz"
      sha256 "48daa51851fdca2e0f26b03ebc19ecf5819996c914cd4b4f00ba7ad630580c73"

      def install
        bin.install "Zephyr" => "zephyr"
        pkgshare.install Dir["core/*"] if Dir.exist?("core")
      end
    end
  end

  test do
    assert_predicate bin/"zephyr", :exist?
  end
end

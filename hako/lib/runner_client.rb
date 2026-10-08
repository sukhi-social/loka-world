# frozen_string_literal: true
# runner(ホストの rootless Podman)と話す、小さな HTTP クライアント。Unix ソケットだけ。
# 依存は標準ライブラリだけ。runner の窓口は runner/loka_runner.py にある。
require "socket"
require "json"

module Hako
  class Runner
    class Unavailable < StandardError; end

    def initialize(sock)
      @sock = sock
    end

    def available?
      !@sock.to_s.empty? && File.socket?(@sock)
    end

    # body_path があれば、そのファイルを body に。out_path があれば、body をそこへ書く。
    # 返しは [status, body(文字列。out_path のときは nil)]
    def request(method, path, body_path: nil, out_path: nil)
      sock = UNIXSocket.new(@sock)
      size = body_path ? File.size(body_path) : 0
      head = "#{method} #{path} HTTP/1.1\r\nHost: runner\r\nConnection: close\r\nContent-Length: #{size}\r\n\r\n"
      sock.write(head)
      File.open(body_path, "rb") { |f| IO.copy_stream(f, sock) } if body_path
      status_line = sock.gets or raise Unavailable, "runner が応えない"
      status = status_line.split(" ")[1].to_i
      length = nil
      while (line = sock.gets) && line != "\r\n"
        length = line.split(":", 2)[1].to_i if line.downcase.start_with?("content-length:")
      end
      if out_path && status == 200
        File.open(out_path, "wb") { |f| IO.copy_stream(sock, f, length) }
        [status, nil]
      else
        [status, sock.read(length || 0).to_s.dup.force_encoding("UTF-8")]
      end
    rescue SystemCallError, IOError => e
      raise Unavailable, "runner に届かない: #{e.message}"
    ensure
      sock&.close
    end

    def json(method, path, **opts)
      status, body = request(method, path, **opts)
      [status, (JSON.parse(body, symbolize_names: true) rescue { error: body })]
    end
  end
end

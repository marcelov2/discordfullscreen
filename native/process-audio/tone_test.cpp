// Diagnostic only: a quiet tone from one process with its own HWND.
#include <windows.h>
#include <mmsystem.h>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <vector>

int wmain(int argc, wchar_t** argv) {
  const double frequency = argc > 1 ? _wtof(argv[1]) : 440.0;
  HWND window = CreateWindowExW(0, L"STATIC", L"Harbor audio isolation test", 0,
                                0, 0, 1, 1, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!window) return 1;
  std::printf("%llu\n", static_cast<unsigned long long>(reinterpret_cast<ULONG_PTR>(window)));
  std::fflush(stdout);
  WAVEFORMATEX format{WAVE_FORMAT_PCM, 2, 48000, 192000, 4, 16, 0};
  HWAVEOUT output = nullptr;
  if (waveOutOpen(&output, WAVE_MAPPER, &format, 0, 0, CALLBACK_NULL) != MMSYSERR_NOERROR) return 2;
  std::vector<int16_t> samples(48000 * 2 * 5);
  for (size_t frame = 0; frame < samples.size() / 2; ++frame) {
    int16_t value = static_cast<int16_t>(std::sin(6.283185307179586 * frequency * frame / 48000.0) * 250);
    samples[frame * 2] = value;
    samples[frame * 2 + 1] = value;
  }
  WAVEHDR header{};
  header.lpData = reinterpret_cast<LPSTR>(samples.data());
  header.dwBufferLength = static_cast<DWORD>(samples.size() * sizeof(int16_t));
  waveOutPrepareHeader(output, &header, sizeof(header));
  waveOutWrite(output, &header, sizeof(header));
  Sleep(5200);
  waveOutUnprepareHeader(output, &header, sizeof(header));
  waveOutClose(output);
  DestroyWindow(window);
  return 0;
}

// Captures 16-bit, 48 kHz stereo PCM from one Windows process tree.
// stdout: raw PCM; stderr: READY <pid> 48000 2, or ERROR <HRESULT>.
// Based on the public WASAPI process-loopback contract, not a system mix.
#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <propvarutil.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <vector>

class Activation final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
 public:
  Activation() : ready_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
  ~Activation() {
    if (client_) client_->Release();
    if (ready_) CloseHandle(ready_);
  }

  STDMETHODIMP QueryInterface(REFIID iid, void** value) override {
    if (!value) return E_POINTER;
    *value = nullptr;
    if (iid == __uuidof(IAgileObject)) {
      *value = static_cast<IAgileObject*>(this);
      AddRef();
      return S_OK;
    }
    if (iid == __uuidof(IUnknown) || iid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *value = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
      AddRef();
      return S_OK;
    }
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return ++references_; }
  STDMETHODIMP_(ULONG) Release() override {
    ULONG remaining = --references_;
    if (!remaining) delete this;
    return remaining;
  }
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    IUnknown* unknown = nullptr;
    HRESULT result = E_FAIL;
    HRESULT call = operation->GetActivateResult(&result, &unknown);
    if (SUCCEEDED(call) && SUCCEEDED(result) && unknown) {
      result = unknown->QueryInterface(IID_PPV_ARGS(&client_));
    } else if (FAILED(call)) {
      result = call;
    }
    if (unknown) unknown->Release();
    result_ = result;
    SetEvent(ready_);
    return S_OK;
  }

  HANDLE ready() const { return ready_; }
  HRESULT result() const { return result_; }
  IAudioClient* client() const { return client_; }

 private:
  std::atomic<ULONG> references_{1};
  HANDLE ready_ = nullptr;
  HRESULT result_ = E_FAIL;
  IAudioClient* client_ = nullptr;
};

static int fail(const char* step, HRESULT code) {
  std::fprintf(stderr, "ERROR %s 0x%08lX\n", step, static_cast<unsigned long>(code));
  std::fflush(stderr);
  return 1;
}

int wmain(int argc, wchar_t** argv) {
  if (argc != 2) return fail("argument", E_INVALIDARG);
  wchar_t* end = nullptr;
  unsigned long long parsed = std::wcstoull(argv[1], &end, 0);
  if (!parsed || !end || *end) return fail("window", E_INVALIDARG);
  HWND window = reinterpret_cast<HWND>(static_cast<ULONG_PTR>(parsed));
  if (!IsWindow(window)) return fail("window", E_INVALIDARG);
  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  if (!pid || pid == GetCurrentProcessId()) return fail("process", E_INVALIDARG);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) return fail("com", hr);
  Activation* activation = new Activation();
  AUDIOCLIENT_ACTIVATION_PARAMS params{};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT variant{};
  variant.vt = VT_BLOB;
  variant.blob.cbSize = sizeof(params);
  variant.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
  IActivateAudioInterfaceAsyncOperation* operation = nullptr;
  hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                                   __uuidof(IAudioClient), &variant, activation,
                                   &operation);
  if (FAILED(hr)) {
    activation->Release();
    CoUninitialize();
    return fail("activate", hr);
  }
  DWORD wait = WaitForSingleObject(activation->ready(), INFINITE);
  if (operation) operation->Release();
  if (wait != WAIT_OBJECT_0 || FAILED(activation->result())) {
    hr = wait == WAIT_OBJECT_0 ? activation->result() : HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    activation->Release();
    CoUninitialize();
    return fail("activate-result", hr);
  }

  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = 2;
  format.nSamplesPerSec = 48000;
  format.wBitsPerSample = 16;
  format.nBlockAlign = 4;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  HANDLE sampleEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  IAudioCaptureClient* capture = nullptr;
  IAudioClient* client = activation->client();
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                          AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                              AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                          0, 0, &format, nullptr);
  if (SUCCEEDED(hr)) hr = client->GetService(IID_PPV_ARGS(&capture));
  if (SUCCEEDED(hr)) hr = client->SetEventHandle(sampleEvent);
  if (SUCCEEDED(hr)) hr = client->Start();
  if (FAILED(hr)) {
    if (capture) capture->Release();
    CloseHandle(sampleEvent);
    activation->Release();
    CoUninitialize();
    return fail("start", hr);
  }
  std::fprintf(stderr, "READY %lu 48000 2\n", pid);
  std::fflush(stderr);
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  std::vector<BYTE> silence;
  for (;;) {
    DWORD sampleWait = WaitForSingleObject(sampleEvent, 1000);
    if (sampleWait == WAIT_TIMEOUT) continue;
    if (sampleWait != WAIT_OBJECT_0) break;
    UINT32 packets = 0;
    while (SUCCEEDED(capture->GetNextPacketSize(&packets)) && packets) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) break;
      DWORD bytes = frames * format.nBlockAlign;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        silence.assign(bytes, 0);
        data = silence.data();
      }
      DWORD written = 0;
      bool ok = WriteFile(output, data, bytes, &written, nullptr) && written == bytes;
      capture->ReleaseBuffer(frames);
      if (!ok) {
        client->Stop();
        capture->Release();
        CloseHandle(sampleEvent);
        activation->Release();
        CoUninitialize();
        return 0;
      }
    }
  }
  client->Stop();
  capture->Release();
  CloseHandle(sampleEvent);
  activation->Release();
  CoUninitialize();
  return 0;
}

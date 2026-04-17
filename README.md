# stash

A private, end to end encrypted personal cloud.

Drop files from any device and access them everywhere. No accounts, no plaintext, everything is encrypted locally before it touches the server. 

---

## Features

**Core**

* Fully client side encryption, server only stores opaque blobs
* No accounts, auth is based on key ownership
* Multi device access using short lived access codes or QR
* Recovery via 12 word phrase, no email, no password reset

**File system**

* Folder based file browser with search
* Multi select, drag and drop, bulk actions
* File previews before download
* Send files directly via external file sharing

**Devices**

* Device list with live status
* Add or remove devices at any time
* Access codes expire automatically

**UX**

* Smooth navigation with history
* Marquee selection
* Upload progress indicators
* Quota tracking

---

## How it works

1. You create a stash

   * A random 256 bit key is generated locally
   * A 12 word recovery phrase is derived from it
2. The server stores only:

   * encrypted metadata
   * encrypted file blobs
   * a wrapped version of the stash key for recovery
3. When you upload files

   * files are encrypted locally
   * uploaded as opaque blobs
4. When you open your stash on another device

   * use an access code or recovery phrase
   * key is reconstructed locally
5. The server never sees filenames, contents, or keys

---

## Encryption

Everything is built around a single client generated stash key.

**Key model**

* One 256 bit stash key per stash
* All other keys are derived using HKDF

  * auth key
  * metadata key
  * file encryption key 

**Auth**

* Challenge response using HMAC over a server nonce
* Server stores a verifier, not the key
* No accounts, no passwords 

**Files**

* AES GCM encryption
* Files are split into chunks and encrypted independently
* Stored as opaque blobs with no metadata visible server side 

**Metadata**

* Entire file tree stored as a single encrypted JSON blob
* Includes names, structure, sizes, timestamps
* Server only sees ciphertext 

**Recovery**

* 12 word BIP39 phrase derived from stash key
* Stash key is wrapped with a key derived via PBKDF2
* Server stores only the wrapped key and salt 

---

## Optimization

A lot of work went into making large files actually usable.

**Streaming + chunking**

* Files are encrypted and uploaded in chunks
* Downloads are streamed and decrypted incrementally
* Avoids loading entire files into memory
* Prevents browser crashes on large files 

**File preview pipeline**

* Previews no longer require full file download
* Uses partial streaming + progressive decryption
* Reduced preview time from minutes to seconds in testing 

**Client side caching**

* Decrypted file buffers are cached in memory
* Reused across preview, download, and sharing
* LRU style trimming with a max memory cap (~300MB) 

**Compression**

* Optional Zstd compression before upload
* Skips already compressed formats like images, video, archives
* Only applied if size reduction is meaningful 

**Progress + partial work**

* Upload and download progress tracked per chunk
* UI updates in real time without blocking

---

## Stack

| Layer       | Tech                             |
| ----------- | -------------------------------- |
| Frontend    | Vanilla JS, HTML, CSS            |
| Crypto      | Web Crypto API                   |
| Compression | Zstd (browser)                   |
| Backend     | Custom API (blob storage + auth) |

---

## Project structure

```
stash/
  frontend/                  # landing page, stash creation, join flow, recovery flow
    index.html
    script.js
    lib.js                   # shared crypto, auth, encoding, and API helpers
    style.css
    /vault                   # main authenticated file browser UI
      index.html
      script.js              # file operations, previews, devices, selection, sync
      style.css

  server.ts                  # backend for auth, metadata, blob storage, recovery, device linking

  /stashes                   # server-side encrypted storage, ignored in git
    /<stashId>/
      metadata.bin           # encrypted vault metadata blob
      recovery.json          # wrapped stash key + recovery metadata
      /blobs                 # encrypted file blobs
```

---

## Running locally

```
git clone https://github.com/rip-super/stash
cd stash
npm install
npm start
```

Open `http://localhost:6003`.

---

## Notes

* The server is intentionally dumb, it only stores and serves encrypted data
* All security depends on keeping the stash key and recovery phrase safe
* If you lose both, the data is unrecoverable by design

---

### If you like this project, feel free to give it a star!
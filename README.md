# سوقناا — Backend API

خادم منصة **سوقناا (Souqnaa)** للأسواق متعددة التجار (Multi-Vendor Marketplace) المبني بواسطة **Node.js / Express / TypeScript** و **Prisma ORM** و **PostgreSQL** و **Upstash Redis** و **Cloudflare R2**.

---

## 🚀 التقنيات المستخدمة (Tech Stack)

- **Language & Runtime**: Node.js v20+ / TypeScript
- **Framework**: Express.js
- **Database & ORM**: PostgreSQL / Prisma ORM
- **Cache & Message Broker**: Upstash Redis (TLS) / BullMQ
- **Object Storage**: Cloudflare R2 / AWS S3 SDK
- **Realtime**: Socket.IO WebSockets
- **Authentication**: JWT (Access + Refresh tokens) & Role-Based Access Control (RBAC)

---

## 🛠️ أوامر التشغيل الأساسية (Scripts)

| الأمر | الوظيفة |
| :--- | :--- |
| `npm run build` | تجميع كود TypeScript إلى JavaScript (`dist/`) |
| `npm run start` | تشغيل الخادم في بيئة الإنتاج (`node dist/server.js`) |
| `npm run dev` | تشغيل الخادم في بيئة التطوير مع التحديث التلقائي (`ts-node-dev`) |
| `npm run prisma:generate` | توليد عميل Prisma Client |
| `npm run prisma:push` | مزامنة مخطط قاعدة البيانات مع PostgreSQL |
| `npm run prisma:seed` | تهيئة وتغذية البيانات الأولية (الفئات، البانرات، قوالب الإشعارات) |
| `npm run lint` | فحص أخطاء الأنواع (`tsc --noEmit`) |

---

## 🌐 نقاط النهاية الرئيسية (Key API Endpoints)

- **الفحص والحالة**:
  - `GET /` — رسالة الترحيب وحالة المنصة
  - `GET /health` — فحص صحة الخادم
  - `GET /ready` — فحص جاهزية قاعدة البيانات وذاكرة Redis
- **المصادقة والمستخدمين**:
  - `POST /api/v1/auth/register` — تسجيل حساب جديد
  - `POST /api/v1/auth/login` — تسجيل الدخول
- **الواجهة الرئيسية والكتالوج**:
  - `GET /api/v1/home` — بيانات الصفحة الرئيسية (البانرات، الفئات، العروض الخاطفة، المنتجات المميزة)
  - `GET /api/v1/categories` — قائمة الفئات والأقسام
  - `GET /api/v1/products` — البحث وتصفح المنتجات
  - `GET /api/v1/promotions/banners` — البانرات الترويجية النشطة
- **الملفات والتخزين**:
  - `POST /api/v1/upload` — رفع ملف إلى Cloudflare R2
  - `GET /api/v1/storage/file/*` — بث واستعراض الملفات والصور مباشرة عبر السيرفر

---

## 📦 النشر على Render (Deployment)

- **Service Type**: Web Service
- **Build Command**: `npm install && npx prisma generate && npm run build`
- **Start Command**: `npx prisma db push && npm run start`
- **Health Check Path**: `/health`
- **Auto Deploy**: مفعّل عبر فرع `main`
import { PrismaClient } from '@prisma/client';

export interface SubcategoryData {
  nameAr: string;
  nameEn: string;
  slug: string;
  icon: string;
}

export interface RootCategoryData {
  nameAr: string;
  nameEn: string;
  slug: string;
  icon: string;
  image: string;
  sortOrder: number;
  subcategories: SubcategoryData[];
}

export const catalogCategories: RootCategoryData[] = [
  {
    "nameAr": "الإلكترونيات والتقنية",
    "nameEn": "Electronics & Technology",
    "slug": "electronics",
    "icon": "devices_rounded",
    "image": "https://images.unsplash.com/photo-1498049794561-7780e7231661?w=800&q=80",
    "sortOrder": 1,
    "subcategories": [
      {
        "nameAr": "الهواتف المحمولة",
        "nameEn": "Mobile Phones",
        "slug": "mobile-phones-smartphones",
        "icon": "smartphone_rounded"
      },
      {
        "nameAr": "الأجهزة اللوحية",
        "nameEn": "Tablets",
        "slug": "tablets-ipads",
        "icon": "tablet_mac_rounded"
      },
      {
        "nameAr": "إكسسوارات الهواتف",
        "nameEn": "Mobile Phone Accessories",
        "slug": "mobile-accessories",
        "icon": "cable_rounded"
      },
      {
        "nameAr": "أجهزة اللابتوب",
        "nameEn": "Laptop Computers",
        "slug": "laptops-computers",
        "icon": "laptop_mac_rounded"
      },
      {
        "nameAr": "أجهزة الكمبيوتر المكتبية",
        "nameEn": "Desktop Computers",
        "slug": "desktop-computers",
        "icon": "desktop_windows_rounded"
      },
      {
        "nameAr": "إكسسوارات الكمبيوتر",
        "nameEn": "Computer Accessories",
        "slug": "computer-accessories",
        "icon": "mouse_rounded"
      },
      {
        "nameAr": "مكونات الكمبيوتر",
        "nameEn": "Computer Components",
        "slug": "computer-components",
        "icon": "developer_board_rounded"
      },
      {
        "nameAr": "ذاكرة الوصول العشوائي",
        "nameEn": "RAM",
        "slug": "ram-memory-cards",
        "icon": "memory_rounded"
      },
      {
        "nameAr": "وحدات تخزين USB",
        "nameEn": "USB Flash Drives",
        "slug": "usb-flash-drives",
        "icon": "usb_rounded"
      },
      {
        "nameAr": "الأقراص الصلبة",
        "nameEn": "Hard Disk Drives (HDD)",
        "slug": "hard-disk-drives",
        "icon": "storage_rounded"
      },
      {
        "nameAr": "أقراص SSD",
        "nameEn": "Solid State Drives (SSD)",
        "slug": "solid-state-drives",
        "icon": "memory_rounded"
      },
      {
        "nameAr": "بطاقات الذاكرة",
        "nameEn": "Memory Cards",
        "slug": "memory-cards",
        "icon": "sd_card_rounded"
      },
      {
        "nameAr": "قطع غيار الإلكترونيات",
        "nameEn": "Electronic Spare Parts",
        "slug": "electronic-spare-parts",
        "icon": "hardware_rounded"
      },
      {
        "nameAr": "قطع غيار الهواتف",
        "nameEn": "Mobile Phone Spare Parts",
        "slug": "phone-spare-parts",
        "icon": "phonelink_setup_rounded"
      },
      {
        "nameAr": "قطع غيار الكمبيوتر",
        "nameEn": "Computer Spare Parts",
        "slug": "computer-laptop-spare-parts",
        "icon": "build_circle_rounded"
      },
      {
        "nameAr": "معدات الشبكات",
        "nameEn": "Networking Equipment",
        "slug": "networking-equipment",
        "icon": "settings_ethernet_rounded"
      },
      {
        "nameAr": "أجهزة الراوتر",
        "nameEn": "Internet Routers",
        "slug": "internet-routers",
        "icon": "router_rounded"
      },
      {
        "nameAr": "أجهزة المودم",
        "nameEn": "Internet Modems",
        "slug": "internet-modems",
        "icon": "wifi_rounded"
      },
      {
        "nameAr": "إكسسوارات الشبكات",
        "nameEn": "Network Accessories",
        "slug": "network-accessories",
        "icon": "cable_rounded"
      },
      {
        "nameAr": "أجهزة التلفزيون",
        "nameEn": "Televisions",
        "slug": "televisions",
        "icon": "tv_rounded"
      },
      {
        "nameAr": "الشاشات",
        "nameEn": "Monitors & Displays",
        "slug": "monitors-displays",
        "icon": "desktop_windows_rounded"
      },
      {
        "nameAr": "الأجهزة الصوتية",
        "nameEn": "Audio Equipment",
        "slug": "audio-equipment",
        "icon": "speaker_rounded"
      },
      {
        "nameAr": "سماعات الرأس ومكبرات الصوت",
        "nameEn": "Headphones & Speakers",
        "slug": "headphones-speakers",
        "icon": "headphones_rounded"
      },
      {
        "nameAr": "الكاميرات والتصوير",
        "nameEn": "Cameras & Photography",
        "slug": "cameras-photography",
        "icon": "photo_camera_rounded"
      },
      {
        "nameAr": "أجهزة الألعاب وملحقاتها",
        "nameEn": "Gaming Consoles & Accessories",
        "slug": "gaming-consoles",
        "icon": "sports_esports_rounded"
      },
      {
        "nameAr": "أجهزة المنزل الذكي",
        "nameEn": "Smart Home Devices",
        "slug": "smart-home-devices",
        "icon": "sensors_rounded"
      },
      {
        "nameAr": "المكونات والإكسسوارات الإلكترونية",
        "nameEn": "Electronic Components & Accessories",
        "slug": "electronic-components-accessories",
        "icon": "electrical_services_rounded"
      },
      {
        "nameAr": "أخرى",
        "nameEn": "Other",
        "slug": "other-electronics",
        "icon": "more_horiz_rounded"
      }
    ]
  },
  {
    "nameAr": "الأزياء والملابس والمجوهرات",
    "nameEn": "Fashion, Clothing & Jewelry",
    "slug": "fashion",
    "icon": "checkroom_rounded",
    "image": "https://images.unsplash.com/photo-1445205170230-053b83016050?w=800&q=80",
    "sortOrder": 2,
    "subcategories": [
      {
        "nameAr": "ملابس رجالية",
        "nameEn": "Men's Clothing",
        "slug": "mens-clothing",
        "icon": "man_rounded"
      },
      {
        "nameAr": "ملابس نسائية",
        "nameEn": "Women's Clothing",
        "slug": "womens-clothing",
        "icon": "woman_rounded"
      },
      {
        "nameAr": "ملابس الأطفال",
        "nameEn": "Children's Clothing",
        "slug": "kids-clothing",
        "icon": "child_care_rounded"
      },
      {
        "nameAr": "أحذية رجالية",
        "nameEn": "Men's Shoes",
        "slug": "mens-shoes",
        "icon": "directions_walk_rounded"
      },
      {
        "nameAr": "أحذية نسائية",
        "nameEn": "Women's Shoes",
        "slug": "womens-shoes",
        "icon": "style_rounded"
      },
      {
        "nameAr": "أحذية الأطفال",
        "nameEn": "Children's Shoes",
        "slug": "kids-shoes",
        "icon": "directions_walk_rounded"
      },
      {
        "nameAr": "الحقائب والمحافظ",
        "nameEn": "Bags & Wallets",
        "slug": "bags-backpacks",
        "icon": "backpack_rounded"
      },
      {
        "nameAr": "الساعات",
        "nameEn": "Watches",
        "slug": "watches",
        "icon": "watch_rounded"
      },
      {
        "nameAr": "مجوهرات الذهب",
        "nameEn": "Gold Jewelry",
        "slug": "gold-jewelry",
        "icon": "diamond_rounded"
      },
      {
        "nameAr": "مجوهرات الفضة",
        "nameEn": "Silver Jewelry",
        "slug": "silver-jewelry",
        "icon": "diamond_rounded"
      },
      {
        "nameAr": "مجوهرات الألماس",
        "nameEn": "Diamond Jewelry",
        "slug": "diamond-jewelry",
        "icon": "auto_awesome_rounded"
      },
      {
        "nameAr": "الخواتم",
        "nameEn": "Rings",
        "slug": "rings",
        "icon": "toll_rounded"
      },
      {
        "nameAr": "القلائد",
        "nameEn": "Necklaces",
        "slug": "necklaces",
        "icon": "stream_rounded"
      },
      {
        "nameAr": "الأساور",
        "nameEn": "Bracelets",
        "slug": "bracelets",
        "icon": "donut_large_rounded"
      },
      {
        "nameAr": "الأقراط",
        "nameEn": "Earrings",
        "slug": "earrings",
        "icon": "stars_rounded"
      },
      {
        "nameAr": "أطقم المجوهرات",
        "nameEn": "Jewelry Sets",
        "slug": "jewelry-sets",
        "icon": "workspace_premium_rounded"
      },
      {
        "nameAr": "المجوهرات اليمنية التقليدية",
        "nameEn": "Yemeni Traditional Jewelry",
        "slug": "yemeni-traditional-jewelry",
        "icon": "stars_rounded"
      },
      {
        "nameAr": "علب وإكسسوارات المجوهرات",
        "nameEn": "Jewelry Boxes & Accessories",
        "slug": "jewelry-boxes-accessories",
        "icon": "inventory_2_rounded"
      },
      {
        "nameAr": "إكسسوارات الأزياء",
        "nameEn": "Fashion Accessories",
        "slug": "fashion-accessories",
        "icon": "style_rounded"
      },
      {
        "nameAr": "الملابس اليمنية التقليدية",
        "nameEn": "Yemeni Traditional Clothing",
        "slug": "traditional-yemeni-clothing",
        "icon": "checkroom_rounded"
      },
      {
        "nameAr": "الجنابي",
        "nameEn": "Jambiyas",
        "slug": "janabiya",
        "icon": "military_tech_rounded"
      },
      {
        "nameAr": "أحزمة الجنابي ومستلزماتها",
        "nameEn": "Jambiya Belts & Accessories",
        "slug": "janabiya-belts",
        "icon": "view_headline_rounded"
      },
      {
        "nameAr": "الشيلان",
        "nameEn": "Shawls",
        "slug": "shawls",
        "icon": "style_rounded"
      },
      {
        "nameAr": "العُصُب وأغطية الرأس التقليدية",
        "nameEn": "Traditional Headwear (Al-Osob)",
        "slug": "asib-supplies",
        "icon": "face_rounded"
      },
      {
        "nameAr": "أخرى",
        "nameEn": "Other",
        "slug": "other-fashion",
        "icon": "more_horiz_rounded"
      }
    ]
  },
  {
    "nameAr": "الجمال والعناية الشخصية",
    "nameEn": "Beauty & Personal Care",
    "slug": "beauty",
    "icon": "spa_rounded",
    "image": "https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?w=800&q=80",
    "sortOrder": 3,
    "subcategories": [
      {
        "nameAr": "العناية بالبشرة",
        "nameEn": "Skincare",
        "slug": "skincare",
        "icon": "face_retouching_natural_rounded"
      },
      {
        "nameAr": "المكياج ومستحضرات التجميل",
        "nameEn": "Makeup & Cosmetics",
        "slug": "makeup",
        "icon": "brush_rounded"
      },
      {
        "nameAr": "منتجات العناية بالشعر",
        "nameEn": "Hair Care Products",
        "slug": "hair-care",
        "icon": "content_cut_rounded"
      },
      {
        "nameAr": "أدوات تصفيف الشعر",
        "nameEn": "Hair Styling Tools",
        "slug": "hair-styling-tools",
        "icon": "auto_fix_high_rounded"
      },
      {
        "nameAr": "العطور",
        "nameEn": "Perfumes & Fragrances",
        "slug": "perfumes-fragrances",
        "icon": "water_drop_rounded"
      },
      {
        "nameAr": "العناية الشخصية للرجال",
        "nameEn": "Men's Grooming",
        "slug": "mens-grooming",
        "icon": "face_rounded"
      },
      {
        "nameAr": "منتجات الاستحمام والعناية بالجسم",
        "nameEn": "Bath & Body Products",
        "slug": "bath-body",
        "icon": "bathtub_rounded"
      },
      {
        "nameAr": "النظافة الشخصية",
        "nameEn": "Personal Hygiene",
        "slug": "personal-hygiene",
        "icon": "clean_hands_rounded"
      },
      {
        "nameAr": "إكسسوارات التجميل",
        "nameEn": "Beauty Accessories",
        "slug": "beauty-accessories",
        "icon": "auto_awesome_rounded"
      },
      {
        "nameAr": "أخرى",
        "nameEn": "Other",
        "slug": "other-beauty",
        "icon": "more_horiz_rounded"
      }
    ]
  },
  {
    "nameAr": "المنزل والأثاث",
    "nameEn": "Home & Furniture",
    "slug": "home-furniture",
    "icon": "chair_rounded",
    "image": "https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=800&q=80",
    "sortOrder": 4,
    "subcategories": [
      {
        "nameAr": "أثاث غرف المعيشة",
        "nameEn": "Living Room Furniture",
        "slug": "living-room-furniture",
        "icon": "weekend_rounded"
      },
      {
        "nameAr": "أثاث غرف النوم",
        "nameEn": "Bedroom Furniture",
        "slug": "bedroom-furniture",
        "icon": "bed_rounded"
      },
      {
        "nameAr": "أثاث غرف الطعام",
        "nameEn": "Dining Room Furniture",
        "slug": "dining-room-furniture",
        "icon": "table_restaurant_rounded"
      },
      {
        "nameAr": "أثاث المكاتب",
        "nameEn": "Office Furniture",
        "slug": "office-furniture",
        "icon": "desk_rounded"
      },
      {
        "nameAr": "ديكورات المنزل",
        "nameEn": "Home Decoration",
        "slug": "home-decor",
        "icon": "auto_awesome_mosaic_rounded"
      },
      {
        "nameAr": "إضاءة المنزل",
        "nameEn": "Home Lighting",
        "slug": "lighting",
        "icon": "lightbulb_rounded"
      },
      {
        "nameAr": "الستائر",
        "nameEn": "Curtains & Blinds",
        "slug": "curtains-carpets",
        "icon": "curtains_rounded"
      },
      {
        "nameAr": "السجاد والموكيت",
        "nameEn": "Carpets & Rugs",
        "slug": "carpets-rugs",
        "icon": "layers_rounded"
      },
      {
        "nameAr": "المفروشات والمراتب",
        "nameEn": "Bedding & Mattresses",
        "slug": "bedding-mattresses",
        "icon": "hotel_rounded"
      },
      {
        "nameAr": "إكسسوارات الحمامات",
        "nameEn": "Bathroom Accessories",
        "slug": "bathroom-accessories",
        "icon": "shower_rounded"
      },
      {
        "nameAr": "التخزين والتنظيم المنزلي",
        "nameEn": "Home Storage & Organization",
        "slug": "storage-organization",
        "icon": "inventory_2_rounded"
      },
      {
        "nameAr": "الخزنات والدواليب البلاستيكية",
        "nameEn": "Plastic Storage Cabinets",
        "slug": "plastic-storage-cabinets",
        "icon": "inventory_2_rounded"
      },
      {
        "nameAr": "الأدراج والمنظمات البلاستيكية",
        "nameEn": "Plastic Drawers & Organizers",
        "slug": "plastic-drawers-organizers",
        "icon": "inbox_rounded"
      },
      {
        "nameAr": "الأرفف وحوامل التخزين",
        "nameEn": "Shelves & Racks",
        "slug": "shelves-racks",
        "icon": "table_rows_rounded"
      },
      {
        "nameAr": "مستلزمات وإكسسوارات المنزل",
        "nameEn": "Home Accessories",
        "slug": "home-accessories",
        "icon": "home_rounded"
      },
      {
        "nameAr": "أخرى",
        "nameEn": "Other",
        "slug": "other-home-furniture",
        "icon": "more_horiz_rounded"
      }
    ]
  },
  {
    "nameAr": "الأجهزة المنزلية",
    "nameEn": "Home Appliances",
    "slug": "home-appliances",
    "icon": "kitchen_rounded",
    "image": "https://images.unsplash.com/photo-1556911220-e15b29be8c8f?w=800&q=80",
    "sortOrder": 5,
    "subcategories": [
      {
        "nameAr": "الثلاجات والمجمدات",
        "nameEn": "Refrigerators & Freezers",
        "slug": "refrigerators-freezers",
        "icon": "kitchen_rounded"
      },
      {
        "nameAr": "الغسالات",
        "nameEn": "Washing Machines",
        "slug": "washing-machines",
        "icon": "local_laundry_service_rounded"
      },
      {
        "nameAr": "المجففات",
        "nameEn": "Dryers",
        "slug": "dryers",
        "icon": "air_rounded"
      },
      {
        "nameAr": "مكيفات الهواء",
        "nameEn": "Air Conditioners",
        "slug": "air-conditioners",
        "icon": "ac_unit_rounded"
      },
      {
        "nameAr": "المراوح وشفاطات الهواء",
        "nameEn": "Fans & Exhaust Fans",
        "slug": "fans-heaters",
        "icon": "air_rounded"
      },
      {
        "nameAr": "أجهزة التدفئة",
        "nameEn": "Heaters",
        "slug": "heaters",
        "icon": "whatshot_rounded"
      },
      {
        "nameAr": "أجهزة المطبخ",
        "nameEn": "Kitchen Appliances",
        "slug": "kitchen-appliances",
        "icon": "coffee_maker_rounded"
      },
      {
        "nameAr": "الأفران والطباخات",
        "nameEn": "Ovens & Cookers",
        "slug": "ovens-cookers",
        "icon": "countertops_rounded"
      },
      {
        "nameAr": "أفران الميكروويف",
        "nameEn": "Microwaves",
        "slug": "microwaves",
        "icon": "microwave_rounded"
      },
      {
        "nameAr": "الخلاطات والعصارات",
        "nameEn": "Blenders & Juicers",
        "slug": "blenders-juicers",
        "icon": "blender_rounded"
      },
      {
        "nameAr": "مبردات وموزعات المياه",
        "nameEn": "Water Dispensers",
        "slug": "water-dispensers",
        "icon": "water_drop_rounded"
      },
      {
        "nameAr": "المكانس الكهربائية",
        "nameEn": "Vacuum Cleaners",
        "slug": "vacuum-cleaners",
        "icon": "cleaning_services_rounded"
      },
      {
        "nameAr": "الأجهزة المنزلية الصغيرة",
        "nameEn": "Small Home Appliances",
        "slug": "small-home-appliances",
        "icon": "devices_other_rounded"
      },
      {
        "nameAr": "قطع غيار الأجهزة المنزلية",
        "nameEn": "Home Appliance Spare Parts",
        "slug": "home-appliance-spare-parts",
        "icon": "settings_rounded"
      },
      {
        "nameAr": "أخرى",
        "nameEn": "Other",
        "slug": "other-home-appliances",
        "icon": "more_horiz_rounded"
      }
    ]
  },
  {
    "nameAr": "السيارات والدراجات النارية",
    "nameEn": "Automotive & Motorcycles",
    "slug": "automotive-motorcycles",
    "icon": "directions_car_rounded",
    "image": "https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=800&q=80",
    "sortOrder": 6,
    "subcategories": [
      {
        "nameAr": "السيارات",
        "nameEn": "Cars",
        "slug": "cars",
        "icon": "directions_car_rounded"
      },
      {
        "nameAr": "الدراجات النارية",
        "nameEn": "Motorcycles",
        "slug": "motorcycles",
        "icon": "two_wheeler_rounded"
      },
      {
        "nameAr": "الدراجات النارية الكهربائية",
        "nameEn": "Electric Motorcycles",
        "slug": "motorcycles-electric-bikes",
        "icon": "electric_moped_rounded"
      },
      {
        "nameAr": "قطع غيار السيارات",
        "nameEn": "Car Spare Parts",
        "slug": "car-spare-parts",
        "icon": "settings_applications_rounded"
      },
      {
        "nameAr": "قطع غيار ومستلزمات الدراجات النارية",
        "nameEn": "Motorcycle Spare Parts",
        "slug": "motorcycle-spare-parts",
        "icon": "build_rounded"
      },
      {
        "nameAr": "إكسسوارات الدراجات النارية",
        "nameEn": "Motorcycle Accessories",
        "slug": "motorcycle-accessories",
        "icon": "moped_rounded"
      },
      {
        "nameAr": "بطاريات الدراجات النارية ومستلزمات الشحن",
        "nameEn": "Motorcycle Batteries & Charging Accessories",
        "slug": "motorcycle-batteries-charging",
        "icon": "battery_charging_full_rounded"
      },
      {
        "nameAr": "الإطارات والعجلات",
        "nameEn": "Tires & Wheels",
        "slug": "tires-wheels",
        "icon": "tire_repair_rounded"
      },
      {
        "nameAr": "بطاريات السيارات",
        "nameEn": "Car Batteries",
        "slug": "car-batteries",
        "icon": "battery_charging_full_rounded"
      },
      {
        "nameAr": "محركات ومكونات الدراجات النارية",
        "nameEn": "Motorcycle Engines & Components",
        "slug": "motorcycle-engines-components",
        "icon": "engineering_rounded"
      },
      {
        "nameAr": "الزيوت والسوائل",
        "nameEn": "Oils & Automotive Fluids",
        "slug": "oils-fluids",
        "icon": "oil_barrel_rounded"
      },
      {
        "nameAr": "إلكترونيات السيارات",
        "nameEn": "Car Electronics",
        "slug": "car-electronics",
        "icon": "electric_car_rounded"
      },
      {
        "nameAr": "إكسسوارات السيارات",
        "nameEn": "Car Accessories",
        "slug": "car-accessories",
        "icon": "car_repair_rounded"
      },
      {
        "nameAr": "العناية بالمركبات والتنظيف",
        "nameEn": "Vehicle Care & Cleaning",
        "slug": "car-care-cleaning",
        "icon": "local_car_wash_rounded"
      },
      {
        "nameAr": "الخوذ ومعدات السلامة",
        "nameEn": "Helmets & Safety Equipment",
        "slug": "helmets-safety-equipment",
        "icon": "sports_motorsports_rounded"
      },
      {
        "nameAr": "محركات السيارات",
        "nameEn": "Car Engines",
        "slug": "car-engines",
        "icon": "engineering_rounded"
      },
      {
        "nameAr": "أخرى",
        "nameEn": "Other",
        "slug": "other-automotive-motorcycles",
        "icon": "more_horiz_rounded"
      }
    ]
  },
  {
    "nameAr": "الطاقة الشمسية ومعدات الطاقة",
    "nameEn": "Solar Energy & Power Equipment",
    "slug": "solar-energy-power-equipment",
    "icon": "solar_power_rounded",
    "image": "https://images.unsplash.com/photo-1509391365360-2e959784a276?w=800&q=80",
    "sortOrder": 7,
    "subcategories": [
      {
        "nameAr": "الألواح الشمسية",
        "nameEn": "Solar Panels",
        "slug": "solar-panels",
        "icon": "solar_power_rounded"
      },
      {
        "nameAr": "بطاريات الطاقة الشمسية وتخزين الطاقة",
        "nameEn": "Solar Batteries",
        "slug": "solar-batteries",
        "icon": "battery_charging_full_rounded"
      },
      {
        "nameAr": "محولات الطاقة الشمسية",
        "nameEn": "Solar Inverters",
        "slug": "inverters-power-converters",
        "icon": "electric_bolt_rounded"
      },
      {
        "nameAr": "منظمات الشحن",
        "nameEn": "Solar Charge Controllers",
        "slug": "charge-controllers",
        "icon": "electric_meter_rounded"
      },
      {
        "nameAr": "كابلات وموصلات الطاقة الشمسية",
        "nameEn": "Solar Cables & Connectors",
        "slug": "solar-cables-wires",
        "icon": "cable_rounded"
      },
      {
        "nameAr": "هياكل تثبيت الألواح",
        "nameEn": "Solar Mounting Systems",
        "slug": "solar-mounting-structures",
        "icon": "roofing_rounded"
      },
      {
        "nameAr": "معدات الحماية الشمسية",
        "nameEn": "Solar Protection Equipment",
        "slug": "circuit-breakers-fuses-protection",
        "icon": "shield_rounded"
      },
      {
        "nameAr": "أنظمة الطاقة الشمسية المتكاملة",
        "nameEn": "Complete Solar Systems",
        "slug": "complete-solar-systems",
        "icon": "energy_savings_leaf_rounded"
      },
      {
        "nameAr": "معدات ومستلزمات تركيب الطاقة الشمسية",
        "nameEn": "Solar Installation Equipment & Accessories",
        "slug": "solar-installation-accessories",
        "icon": "hardware_rounded"
      },
      {
        "nameAr": "المولدات الكهربائية",
        "nameEn": "Electric Generators",
        "slug": "electric-generators",
        "icon": "bolt_rounded"
      },
      {
        "nameAr": "مولدات الديزل",
        "nameEn": "Diesel Generators",
        "slug": "diesel-generators",
        "icon": "power_rounded"
      },
      {
        "nameAr": "قطع غيار المولدات",
        "nameEn": "Generator Spare Parts",
        "slug": "generator-spare-parts",
        "icon": "build_rounded"
      },
      {
        "nameAr": "أنظمة الطاقة غير المنقطعة",
        "nameEn": "UPS Systems",
        "slug": "ups-systems",
        "icon": "battery_saver_rounded"
      },
      {
        "nameAr": "أنظمة الطاقة الاحتياطية",
        "nameEn": "Backup Power Systems",
        "slug": "backup-power-systems",
        "icon": "power_rounded"
      },
      {
        "nameAr": "مثبتات ومنظمات الجهد",
        "nameEn": "Voltage Stabilizers",
        "slug": "voltage-stabilizers",
        "icon": "tune_rounded"
      },
      {
        "nameAr": "المحولات الكهربائية",
        "nameEn": "Transformers",
        "slug": "transformers",
        "icon": "transform_rounded"
      },
      {
        "nameAr": "المحركات الكهربائية",
        "nameEn": "Electrical Motors",
        "slug": "electrical-motors",
        "icon": "precision_manufacturing_rounded"
      },
      {
        "nameAr": "معدات توزيع الطاقة",
        "nameEn": "Power Distribution Equipment",
        "slug": "power-distribution-equipment",
        "icon": "alt_route_rounded"
      },
      {
        "nameAr": "قواطع الكهرباء",
        "nameEn": "Circuit Breakers",
        "slug": "circuit-breakers",
        "icon": "power_settings_new_rounded"
      },
      {
        "nameAr": "لوحات الكهرباء والتوزيع",
        "nameEn": "Electrical Panels & Distribution Boards",
        "slug": "electrical-panels-boards",
        "icon": "grid_view_rounded"
      },
      {
        "nameAr": "مزودات الطاقة والمحولات",
        "nameEn": "Power Supplies & Adapters",
        "slug": "power-supplies-adapters",
        "icon": "power_rounded"
      },
      {
        "nameAr": "أجهزة مراقبة الطاقة",
        "nameEn": "Energy Monitoring Devices",
        "slug": "energy-monitoring-devices",
        "icon": "speed_rounded"
      },
      {
        "nameAr": "إكسسوارات وقطع غيار معدات الطاقة",
        "nameEn": "Power Accessories & Spare Parts",
        "slug": "power-accessories-spare-parts",
        "icon": "settings_rounded"
      },
      {
        "nameAr": "أخرى",
        "nameEn": "Other",
        "slug": "other-solar-power",
        "icon": "more_horiz_rounded"
      }
    ]
  },
  {
    "nameAr": "أنظمة ومعدات المياه",
    "nameEn": "Water Systems & Equipment",
    "slug": "water-systems-equipment",
    "icon": "water_drop_rounded",
    "image": "https://images.unsplash.com/photo-1541888946425-d0fbb18086f6?w=800&q=80",
    "sortOrder": 8,
    "subcategories": [
      {
        "nameAr": "مضخات المياه",
        "nameEn": "Water Pumps",
        "slug": "water-pumps",
        "icon": "waves_rounded"
      },
      {
        "nameAr": "خزانات المياه",
        "nameEn": "Water Tanks",
        "slug": "water-tanks",
        "icon": "storage_rounded"
      },
      {
        "nameAr": "فلاتر المياه",
        "nameEn": "Water Filters",
        "slug": "water-filters",
        "icon": "filter_alt_rounded"
      },
      {
        "nameAr": "أنظمة تنقية المياه",
        "nameEn": "Water Purification Systems",
        "slug": "water-purification-systems",
        "icon": "opacity_rounded"
      },
      {
        "nameAr": "أنابيب ووصلات المياه",
        "nameEn": "Water Pipes & Fittings",
        "slug": "water-pipes-fittings",
        "icon": "plumbing_rounded"
      },
      {
        "nameAr": "أجهزة التحكم بمستوى المياه",
        "nameEn": "Water Level Controllers",
        "slug": "water-level-controllers",
        "icon": "tune_rounded"
      },
      {
        "nameAr": "أنظمة ضغط المياه",
        "nameEn": "Water Pressure Systems",
        "slug": "water-pressure-systems",
        "icon": "speed_rounded"
      },
      {
        "nameAr": "قطع غيار المضخات",
        "nameEn": "Pump Spare Parts",
        "slug": "pump-spare-parts",
        "icon": "build_rounded"
      },
      {
        "nameAr": "إكسسوارات أنظمة المياه",
        "nameEn": "Water System Accessories",
        "slug": "water-system-accessories",
        "icon": "water_drop_rounded"
      },
      {
        "nameAr": "أخرى",
        "nameEn": "Other",
        "slug": "other-water-systems",
        "icon": "more_horiz_rounded"
      }
    ]
  },
  {
    "nameAr": "أجهزة المراقبة والحماية",
    "nameEn": "Security & Surveillance",
    "slug": "surveillance-security",
    "icon": "security_rounded",
    "image": "https://images.unsplash.com/photo-1557597774-9d273605dfa9?w=800&q=80",
    "sortOrder": 9,
    "subcategories": [
      {
        "nameAr": "كاميرات المراقبة",
        "nameEn": "CCTV Cameras",
        "slug": "security-cameras",
        "icon": "camera_outdoor_rounded"
      },
      {
        "nameAr": "أجهزة التسجيل DVR وNVR",
        "nameEn": "DVR & NVR Recorders",
        "slug": "dvr-nvr-recorders",
        "icon": "dvr_rounded"
      },
      {
        "nameAr": "أنظمة المراقبة المتكاملة",
        "nameEn": "Complete Surveillance Systems",
        "slug": "complete-surveillance-systems",
        "icon": "linked_camera_rounded"
      },
      {
        "nameAr": "أنظمة الإنذار",
        "nameEn": "Alarm Systems",
        "slug": "alarm-protection-systems",
        "icon": "crisis_alert_rounded"
      },
      {
        "nameAr": "أنظمة التحكم بالدخول",
        "nameEn": "Access Control Systems",
        "slug": "access-control-systems",
        "icon": "sensor_door_rounded"
      },
      {
        "nameAr": "أجهزة البصمة",
        "nameEn": "Fingerprint Devices",
        "slug": "fingerprint-biometric-devices",
        "icon": "fingerprint_rounded"
      },
      {
        "nameAr": "حساسات الحركة",
        "nameEn": "Motion Sensors",
        "slug": "motion-sensors",
        "icon": "sensors_rounded"
      },
      {
        "nameAr": "الأقفال الذكية",
        "nameEn": "Smart Locks",
        "slug": "smart-locks-security",
        "icon": "phonelink_lock_rounded"
      },
      {
        "nameAr": "معدات الحماية والأمن",
        "nameEn": "Security Equipment",
        "slug": "security-equipment",
        "icon": "shield_rounded"
      },
      {
        "nameAr": "كابلات وملحقات المراقبة",
        "nameEn": "Surveillance Cables & Accessories",
        "slug": "cctv-cables-accessories",
        "icon": "cable_rounded"
      },
      {
        "nameAr": "أخرى",
        "nameEn": "Other",
        "slug": "other-security-surveillance",
        "icon": "more_horiz_rounded"
      }
    ]
  },
  {
    "nameAr": "مواد البناء والبلاط والرخام",
    "nameEn": "Building Materials, Tiles & Marble",
    "slug": "building-materials-tiles-marble",
    "icon": "foundation_rounded",
    "image": "https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=800&q=80",
    "sortOrder": 10,
    "subcategories": [
      {
        "nameAr": "بلاط السيراميك",
        "nameEn": "Ceramic Tiles",
        "slug": "ceramic-tiles",
        "icon": "grid_on_rounded"
      },
      {
        "nameAr": "بلاط البورسلان",
        "nameEn": "Porcelain Tiles",
        "slug": "porcelain-tiles",
        "icon": "dashboard_rounded"
      },
      {
        "nameAr": "بلاط الأرضيات",
        "nameEn": "Floor Tiles",
        "slug": "floor-tiles",
        "icon": "texture_rounded"
      },
      {
        "nameAr": "بلاط الجدران",
        "nameEn": "Wall Tiles",
        "slug": "wall-tiles",
        "icon": "wallpaper_rounded"
      },
      {
        "nameAr": "بلاط الحمامات",
        "nameEn": "Bathroom Tiles",
        "slug": "bathroom-tiles",
        "icon": "shower_rounded"
      },
      {
        "nameAr": "بلاط المطابخ",
        "nameEn": "Kitchen Tiles",
        "slug": "kitchen-tiles",
        "icon": "kitchen_rounded"
      },
      {
        "nameAr": "بلاط خارجي",
        "nameEn": "Outdoor Tiles",
        "slug": "outdoor-tiles",
        "icon": "deck_rounded"
      },
      {
        "nameAr": "البلاط الديكوري",
        "nameEn": "Decorative Tiles",
        "slug": "decorative-tiles",
        "icon": "auto_awesome_mosaic_rounded"
      },
      {
        "nameAr": "لواصق وروبة البلاط",
        "nameEn": "Tile Adhesives & Grout",
        "slug": "tile-adhesives-grout",
        "icon": "format_paint_rounded"
      },
      {
        "nameAr": "مستلزمات تركيب البلاط",
        "nameEn": "Tile Installation Accessories",
        "slug": "tile-installation-accessories",
        "icon": "handyman_rounded"
      },
      {
        "nameAr": "الرخام الطبيعي",
        "nameEn": "Natural Marble",
        "slug": "natural-marble",
        "icon": "diamond_rounded"
      },
      {
        "nameAr": "الرخام الصناعي",
        "nameEn": "Artificial Marble",
        "slug": "artificial-marble",
        "icon": "interests_rounded"
      },
      {
        "nameAr": "الجرانيت",
        "nameEn": "Granite",
        "slug": "granite",
        "icon": "landscape_rounded"
      },
      {
        "nameAr": "ألواح الرخام والجرانيت",
        "nameEn": "Marble & Granite Slabs",
        "slug": "marble-granite-slabs",
        "icon": "layers_rounded"
      },
      {
        "nameAr": "بلاط الرخام",
        "nameEn": "Marble Tiles",
        "slug": "marble-tiles",
        "icon": "grid_on_rounded"
      },
      {
        "nameAr": "أسطح المطابخ والكاونترات",
        "nameEn": "Countertops",
        "slug": "countertops-surfaces",
        "icon": "countertops_rounded"
      },
      {
        "nameAr": "درج وكسوة الرخام",
        "nameEn": "Marble Stairs & Wall Cladding",
        "slug": "marble-stairs-wall-cladding",
        "icon": "stairs_rounded"
      },
      {
        "nameAr": "مستلزمات قص وتركيب الرخام",
        "nameEn": "Marble Cutting & Installation Supplies",
        "slug": "marble-cutting-installation",
        "icon": "carpenter_rounded"
      },
      {
        "nameAr": "العناية بالرخام وتلميعه",
        "nameEn": "Marble Care & Polishing",
        "slug": "marble-care-polishing",
        "icon": "auto_awesome_rounded"
      },
      {
        "nameAr": "الأبواب الخشبية",
        "nameEn": "Wooden Doors",
        "slug": "wooden-doors",
        "icon": "door_front_door_rounded"
      },
      {
        "nameAr": "الأبواب الحديدية",
        "nameEn": "Iron Doors",
        "slug": "iron-steel-doors",
        "icon": "door_back_door_rounded"
      },
      {
        "nameAr": "الأبواب الألمنيوم",
        "nameEn": "Aluminum Doors",
        "slug": "aluminum-doors",
        "icon": "door_sliding_rounded"
      },
      {
        "nameAr": "أبواب PVC",
        "nameEn": "PVC Doors",
        "slug": "plastic-pvc-doors",
        "icon": "meeting_room_rounded"
      },
      {
        "nameAr": "نوافذ الألمنيوم",
        "nameEn": "Aluminum Windows",
        "slug": "aluminum-windows",
        "icon": "window_rounded"
      },
      {
        "nameAr": "الأبواب الزجاجية",
        "nameEn": "Glass Doors",
        "slug": "glass-doors",
        "icon": "sensor_door_rounded"
      },
      {
        "nameAr": "الزجاج المقسى",
        "nameEn": "Tempered Glass",
        "slug": "tempered-glass",
        "icon": "shield_rounded"
      },
      {
        "nameAr": "المرايا",
        "nameEn": "Mirrors",
        "slug": "mirrors",
        "icon": "crop_original_rounded"
      },
      {
        "nameAr": "قطاعات الألمنيوم",
        "nameEn": "Aluminum Profiles",
        "slug": "aluminum-profiles",
        "icon": "view_column_rounded"
      },
      {
        "nameAr": "مقابض وأقفال الأبواب",
        "nameEn": "Door Handles & Locks",
        "slug": "door-handles-accessories",
        "icon": "key_rounded"
      },
      {
        "nameAr": "المفصلات وإكسسوارات الأبواب",
        "nameEn": "Hinges & Door Accessories",
        "slug": "locks-hinges",
        "icon": "lock_rounded"
      },
      {
        "nameAr": "الأدوات الصحية",
        "nameEn": "Sanitary Ware",
        "slug": "sanitary-ware",
        "icon": "plumbing_rounded"
      },
      {
        "nameAr": "المراحيض والمغاسل",
        "nameEn": "Toilets & Basins",
        "slug": "toilets-basins",
        "icon": "wash_rounded"
      },
      {
        "nameAr": "أحوض الاستحمام",
        "nameEn": "Bathtubs",
        "slug": "bathtubs",
        "icon": "bathtub_rounded"
      },
      {
        "nameAr": "الحنفيات والخلاطات",
        "nameEn": "Faucets & Mixers",
        "slug": "faucets-mixers",
        "icon": "shower_rounded"
      },
      {
        "nameAr": "الدش ومستلزماته",
        "nameEn": "Showers",
        "slug": "showers",
        "icon": "shower_rounded"
      },
      {
        "nameAr": "خزائن وتجهيزات الحمامات",
        "nameEn": "Bathroom Cabinets & Fittings",
        "slug": "bathroom-cabinets-fittings",
        "icon": "inventory_2_rounded"
      },
      {
        "nameAr": "الإسمنت ومستلزمات البناء",
        "nameEn": "Cement & Building Supplies",
        "slug": "cement-building-supplies",
        "icon": "foundation_rounded"
      },
      {
        "nameAr": "مستلزمات الكهرباء للبناء",
        "nameEn": "Electrical Building Supplies",
        "slug": "electrical-building-supplies",
        "icon": "electrical_services_rounded"
      },
      {
        "nameAr": "مستلزمات السباكة",
        "nameEn": "Plumbing Supplies",
        "slug": "plumbing-supplies",
        "icon": "plumbing_rounded"
      },
      {
        "nameAr": "الدهانات والطلاءات",
        "nameEn": "Paints & Coatings",
        "slug": "paints-coatings",
        "icon": "format_paint_rounded"
      },
      {
        "nameAr": "مواد العزل المائي",
        "nameEn": "Waterproofing Materials",
        "slug": "waterproofing-materials",
        "icon": "layers_rounded"
      },
      {
        "nameAr": "مواد العزل الحراري والصوتي",
        "nameEn": "Insulation Materials",
        "slug": "insulation-materials",
        "icon": "shield_rounded"
      },
      {
        "nameAr": "مواد التشطيب",
        "nameEn": "Finishing Materials",
        "slug": "finishing-materials",
        "icon": "brush_rounded"
      },
      {
        "nameAr": "أخرى",
        "nameEn": "Other",
        "slug": "other-building-materials",
        "icon": "more_horiz_rounded"
      }
    ]
  },
  {
    "nameAr": "الأدوات والمعدات",
    "nameEn": "Tools & Hardware",
    "slug": "tools-hardware",
    "icon": "build_rounded",
    "image": "https://images.unsplash.com/photo-1581783342308-f792dbdd27c5?w=800&q=80",
    "sortOrder": 11,
    "subcategories": [
      {
        "nameAr": "الأدوات اليدوية",
        "nameEn": "Hand Tools",
        "slug": "hand-tools",
        "icon": "handyman_rounded"
      },
      {
        "nameAr": "الأدوات الكهربائية",
        "nameEn": "Power Tools",
        "slug": "power-tools",
        "icon": "hardware_rounded"
      },
      {
        "nameAr": "أدوات الورش",
        "nameEn": "Workshop Tools",
        "slug": "workshop-tools",
        "icon": "construction_rounded"
      },
      {
        "nameAr": "الأدوات الصناعية",
        "nameEn": "Industrial Tools",
        "slug": "industrial-tools",
        "icon": "precision_manufacturing_rounded"
      },
      {
        "nameAr": "أدوات القياس",
        "nameEn": "Measuring Tools",
        "slug": "measuring-tools",
        "icon": "straighten_rounded"
      },
      {
        "nameAr": "الأقفال ومستلزمات الأمان",
        "nameEn": "Locks & Security Hardware",
        "slug": "locks-security",
        "icon": "lock_rounded"
      },
      {
        "nameAr": "البراغي والمثبتات",
        "nameEn": "Fasteners & Fixings",
        "slug": "fasteners-fixings",
        "icon": "push_pin_rounded"
      },
      {
        "nameAr": "معدات السلامة",
        "nameEn": "Safety Equipment",
        "slug": "safety-equipment",
        "icon": "security_rounded"
      },
      {
        "nameAr": "تخزين وتنظيم الأدوات",
        "nameEn": "Tool Storage",
        "slug": "tool-storage",
        "icon": "inventory_rounded"
      },
      {
        "nameAr": "أخرى",
        "nameEn": "Other",
        "slug": "other-tools-hardware",
        "icon": "more_horiz_rounded"
      }
    ]
  },
  {
    "nameAr": "الرياضة والأنشطة الخارجية",
    "nameEn": "Sports & Outdoors",
    "slug": "sports",
    "icon": "sports_soccer_rounded",
    "image": "https://images.unsplash.com/photo-1461896836934-ffe607ba8211?w=800&q=80",
    "sortOrder": 12,
    "subcategories": [
      {
        "nameAr": "معدات اللياقة والنوادي",
        "nameEn": "Fitness & Gym Equipment",
        "slug": "fitness-gym-equipment",
        "icon": "fitness_center_rounded"
      },
      {
        "nameAr": "معدات كرة القدم",
        "nameEn": "Football Equipment",
        "slug": "football-equipment",
        "icon": "sports_soccer_rounded"
      },
      {
        "nameAr": "معدات الرياضات الجماعية",
        "nameEn": "Team Sports Equipment",
        "slug": "team-sports-equipment",
        "icon": "sports_volleyball_rounded"
      },
      {
        "nameAr": "الملابس الرياضية",
        "nameEn": "Sportswear",
        "slug": "sportswear",
        "icon": "checkroom_rounded"
      },
      {
        "nameAr": "الأحذية الرياضية",
        "nameEn": "Sports Shoes",
        "slug": "sports-shoes",
        "icon": "directions_run_rounded"
      },
      {
        "nameAr": "الدراجات الهوائية",
        "nameEn": "Bicycles",
        "slug": "bicycles",
        "icon": "pedal_bike_rounded"
      },
      {
        "nameAr": "معدات التخييم",
        "nameEn": "Camping Equipment",
        "slug": "camping-hiking",
        "icon": "terrain_rounded"
      },
      {
        "nameAr": "معدات الرحلات والمشي الجبلي",
        "nameEn": "Hiking Equipment",
        "slug": "hiking-equipment",
        "icon": "hiking_rounded"
      },
      {
        "nameAr": "مستلزمات الأنشطة الخارجية",
        "nameEn": "Outdoor Accessories",
        "slug": "outdoor-accessories",
        "icon": "backpack_rounded"
      },
      {
        "nameAr": "أخرى",
        "nameEn": "Other",
        "slug": "other-sports",
        "icon": "more_horiz_rounded"
      }
    ]
  },
  {
    "nameAr": "الأطفال والألعاب",
    "nameEn": "Baby, Kids & Toys",
    "slug": "baby-kids-toys",
    "icon": "toys_rounded",
    "image": "https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=800&q=80",
    "sortOrder": 13,
    "subcategories": [
      {
        "nameAr": "ملابس الأطفال الرضع",
        "nameEn": "Baby Clothing",
        "slug": "baby-clothing",
        "icon": "child_care_rounded"
      },
      {
        "nameAr": "منتجات تغذية الرضع",
        "nameEn": "Baby Feeding Products",
        "slug": "baby-feeding",
        "icon": "restaurant_rounded"
      },
      {
        "nameAr": "الحفاضات",
        "nameEn": "Diapers",
        "slug": "diapers",
        "icon": "baby_changing_station_rounded"
      },
      {
        "nameAr": "منتجات العناية بالرضع",
        "nameEn": "Baby Care Products",
        "slug": "baby-care-products",
        "icon": "soap_rounded"
      },
      {
        "nameAr": "عربات الأطفال",
        "nameEn": "Strollers",
        "slug": "strollers-car-seats",
        "icon": "stroller_rounded"
      },
      {
        "nameAr": "مقاعد الأطفال للسيارات",
        "nameEn": "Baby Car Seats",
        "slug": "baby-car-seats",
        "icon": "chair_rounded"
      },
      {
        "nameAr": "الألعاب التعليمية",
        "nameEn": "Educational Toys",
        "slug": "educational-toys",
        "icon": "extension_rounded"
      },
      {
        "nameAr": "الدمى والشخصيات",
        "nameEn": "Dolls & Action Figures",
        "slug": "dolls-action-figures",
        "icon": "accessibility_new_rounded"
      },
      {
        "nameAr": "الألعاب الخارجية",
        "nameEn": "Outdoor Toys",
        "slug": "outdoor-toys",
        "icon": "sports_baseball_rounded"
      },
      {
        "nameAr": "أثاث الأطفال",
        "nameEn": "Baby Furniture",
        "slug": "baby-furniture",
        "icon": "crib_rounded"
      },
      {
        "nameAr": "أخرى",
        "nameEn": "Other",
        "slug": "other-baby-kids-toys",
        "icon": "more_horiz_rounded"
      }
    ]
  },
  {
    "nameAr": "الكتب والقرطاسية والمكاتب",
    "nameEn": "Books, Stationery & Office",
    "slug": "books-stationery-office",
    "icon": "menu_book_rounded",
    "image": "https://images.unsplash.com/photo-1456513080510-7bf3a84b82f8?w=800&q=80",
    "sortOrder": 14,
    "subcategories": [
      {
        "nameAr": "الكتب والروايات",
        "nameEn": "Books & Novels",
        "slug": "books-novels",
        "icon": "auto_stories_rounded"
      },
      {
        "nameAr": "المستلزمات المدرسية",
        "nameEn": "School Supplies",
        "slug": "school-supplies",
        "icon": "school_rounded"
      },
      {
        "nameAr": "الدفاتر والورق",
        "nameEn": "Notebooks & Paper",
        "slug": "notebooks-paper",
        "icon": "note_alt_rounded"
      },
      {
        "nameAr": "الأقلام وأدوات الكتابة",
        "nameEn": "Pens & Writing Supplies",
        "slug": "pens-writing-tools",
        "icon": "draw_rounded"
      },
      {
        "nameAr": "مستلزمات المكاتب",
        "nameEn": "Office Supplies",
        "slug": "office-supplies",
        "icon": "business_center_rounded"
      },
      {
        "nameAr": "الطابعات والماسحات",
        "nameEn": "Printers & Scanners",
        "slug": "printers-scanners",
        "icon": "print_rounded"
      },
      {
        "nameAr": "تقنيات وأجهزة المكاتب",
        "nameEn": "Office Technology",
        "slug": "office-technology",
        "icon": "devices_other_rounded"
      },
      {
        "nameAr": "مستلزمات الفنون والأشغال اليدوية",
        "nameEn": "Arts & Crafts Supplies",
        "slug": "art-craft-supplies",
        "icon": "palette_rounded"
      },
      {
        "nameAr": "أخرى",
        "nameEn": "Other",
        "slug": "other-books-stationery",
        "icon": "more_horiz_rounded"
      }
    ]
  },
  {
    "nameAr": "الأقمشة والمنسوجات",
    "nameEn": "Fabrics & Textiles",
    "slug": "fabrics-textiles",
    "icon": "texture_rounded",
    "image": "https://images.unsplash.com/photo-1528459801416-a9e53bbf4e17?w=800&q=80",
    "sortOrder": 15,
    "subcategories": [
      {
        "nameAr": "أقمشة الملابس",
        "nameEn": "Clothing Fabrics",
        "slug": "clothing-fabrics",
        "icon": "checkroom_rounded"
      },
      {
        "nameAr": "أقمشة التنجيد",
        "nameEn": "Upholstery Fabrics",
        "slug": "upholstery-fabrics",
        "icon": "chair_rounded"
      },
      {
        "nameAr": "أقمشة الستائر",
        "nameEn": "Curtain Fabrics",
        "slug": "curtain-fabrics",
        "icon": "curtains_rounded"
      },
      {
        "nameAr": "مستلزمات الخياطة",
        "nameEn": "Sewing Accessories",
        "slug": "sewing-accessories",
        "icon": "content_cut_rounded"
      },
      {
        "nameAr": "البطانيات",
        "nameEn": "Blankets",
        "slug": "blankets",
        "icon": "bed_rounded"
      },
      {
        "nameAr": "اللحف والألحفة",
        "nameEn": "Quilts & Comforters",
        "slug": "quilts-comforters",
        "icon": "hotel_rounded"
      },
      {
        "nameAr": "المناشف",
        "nameEn": "Towels",
        "slug": "towels",
        "icon": "dry_rounded"
      },
      {
        "nameAr": "المنسوجات المنزلية",
        "nameEn": "Home Textiles",
        "slug": "home-textiles",
        "icon": "texture_rounded"
      },
      {
        "nameAr": "أخرى",
        "nameEn": "Other",
        "slug": "other-fabrics-textiles",
        "icon": "more_horiz_rounded"
      }
    ]
  },
  {
    "nameAr": "الأعمال والمعدات التجارية والصناعية",
    "nameEn": "Business, Commercial & Industrial",
    "slug": "business-industrial",
    "icon": "precision_manufacturing_rounded",
    "image": "https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=800&q=80",
    "sortOrder": 16,
    "subcategories": [
      {
        "nameAr": "المعدات التجارية",
        "nameEn": "Commercial Equipment",
        "slug": "commercial-equipment",
        "icon": "storefront_rounded"
      },
      {
        "nameAr": "الآلات الصناعية",
        "nameEn": "Industrial Machinery",
        "slug": "industrial-machinery",
        "icon": "factory_rounded"
      },
      {
        "nameAr": "معدات المطاعم",
        "nameEn": "Restaurant Equipment",
        "slug": "restaurant-equipment",
        "icon": "restaurant_rounded"
      },
      {
        "nameAr": "معدات المخابز",
        "nameEn": "Bakery Equipment",
        "slug": "bakery-equipment",
        "icon": "bakery_dining_rounded"
      },
      {
        "nameAr": "معدات الورش",
        "nameEn": "Workshop Equipment",
        "slug": "workshop-equipment",
        "icon": "construction_rounded"
      },
      {
        "nameAr": "ثلاجات العرض والتبريد التجارية",
        "nameEn": "Commercial Refrigerators",
        "slug": "commercial-refrigerators",
        "icon": "kitchen_rounded"
      },
      {
        "nameAr": "آلات القهوة",
        "nameEn": "Coffee Machines",
        "slug": "commercial-coffee-machines",
        "icon": "coffee_maker_rounded"
      },
      {
        "nameAr": "معدات عرض المتاجر",
        "nameEn": "Shop Display Equipment",
        "slug": "shop-display-equipment",
        "icon": "table_rows_rounded"
      },
      {
        "nameAr": "معدات ومستلزمات التغليف",
        "nameEn": "Packaging Equipment & Supplies",
        "slug": "packaging-supplies",
        "icon": "inventory_rounded"
      },
      {
        "nameAr": "مستلزمات الأعمال بالجملة",
        "nameEn": "Wholesale Business Supplies",
        "slug": "wholesale-supplies",
        "icon": "all_inbox_rounded"
      },
      {
        "nameAr": "أخرى",
        "nameEn": "Other",
        "slug": "other-business-industrial",
        "icon": "more_horiz_rounded"
      }
    ]
  },
  {
    "nameAr": "الحدائق والزراعة",
    "nameEn": "Garden & Agriculture",
    "slug": "garden-agriculture",
    "icon": "yard_rounded",
    "image": "https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=800&q=80",
    "sortOrder": 17,
    "subcategories": [
      {
        "nameAr": "النباتات والبذور",
        "nameEn": "Plants & Seeds",
        "slug": "plants-seeds",
        "icon": "grass_rounded"
      },
      {
        "nameAr": "أدوات البستنة",
        "nameEn": "Gardening Tools",
        "slug": "gardening-tools",
        "icon": "agriculture_rounded"
      },
      {
        "nameAr": "معدات الري",
        "nameEn": "Irrigation Equipment",
        "slug": "irrigation-equipment",
        "icon": "water_drop_rounded"
      },
      {
        "nameAr": "الأسمدة والتربة",
        "nameEn": "Fertilizers & Soil",
        "slug": "fertilizers-soil",
        "icon": "eco_rounded"
      },
      {
        "nameAr": "المعدات الزراعية",
        "nameEn": "Agricultural Equipment",
        "slug": "agricultural-equipment",
        "icon": "precision_manufacturing_rounded"
      },
      {
        "nameAr": "مستلزمات الدواجن",
        "nameEn": "Poultry Supplies",
        "slug": "poultry-supplies",
        "icon": "pets_rounded"
      },
      {
        "nameAr": "مستلزمات المواشي",
        "nameEn": "Livestock Supplies",
        "slug": "livestock-supplies",
        "icon": "pets_rounded"
      },
      {
        "nameAr": "أخرى",
        "nameEn": "Other",
        "slug": "other-garden-agriculture",
        "icon": "more_horiz_rounded"
      }
    ]
  },
  {
    "nameAr": "الهدايا والحرف والمنتجات التقليدية",
    "nameEn": "Gifts, Crafts & Traditional Products",
    "slug": "gifts-crafts-traditional",
    "icon": "card_giftcard_rounded",
    "image": "https://images.unsplash.com/photo-1513519245088-0e12902e5a38?w=800&q=80",
    "sortOrder": 18,
    "subcategories": [
      {
        "nameAr": "الهدايا",
        "nameEn": "Gift Items",
        "slug": "gift-items",
        "icon": "card_giftcard_rounded"
      },
      {
        "nameAr": "المنتجات اليدوية",
        "nameEn": "Handmade Products",
        "slug": "handmade-products",
        "icon": "interests_rounded"
      },
      {
        "nameAr": "الحرف اليدوية اليمنية",
        "nameEn": "Yemeni Handicrafts",
        "slug": "yemeni-handicrafts",
        "icon": "workspace_premium_rounded"
      },
      {
        "nameAr": "المنتجات الفضية التقليدية",
        "nameEn": "Traditional Silver Products",
        "slug": "traditional-silver-jewelry",
        "icon": "diamond_rounded"
      },
      {
        "nameAr": "العسل اليمني",
        "nameEn": "Yemeni Honey",
        "slug": "yemeni-honey",
        "icon": "hive_rounded"
      },
      {
        "nameAr": "التذكارات",
        "nameEn": "Souvenirs",
        "slug": "souvenirs",
        "icon": "celebration_rounded"
      },
      {
        "nameAr": "أخرى",
        "nameEn": "Other",
        "slug": "other-gifts-crafts",
        "icon": "more_horiz_rounded"
      }
    ]
  },
  {
    "nameAr": "الصحة والعافية",
    "nameEn": "Health & Wellness",
    "slug": "health-wellness",
    "icon": "health_and_safety_rounded",
    "image": "https://images.unsplash.com/photo-1505751172876-fa1923c5c528?w=800&q=80",
    "sortOrder": 19,
    "subcategories": [
      {
        "nameAr": "منتجات العناية الصحية",
        "nameEn": "Health Care Products",
        "slug": "health-care-products",
        "icon": "health_and_safety_rounded"
      },
      {
        "nameAr": "الأجهزة والمعدات الطبية",
        "nameEn": "Medical Devices & Equipment",
        "slug": "medical-devices-equipment",
        "icon": "monitor_heart_rounded"
      },
      {
        "nameAr": "أجهزة قياس ضغط الدم",
        "nameEn": "Blood Pressure Monitors",
        "slug": "blood-pressure-monitors",
        "icon": "speed_rounded"
      },
      {
        "nameAr": "أجهزة قياس سكر الدم",
        "nameEn": "Blood Glucose Monitors",
        "slug": "blood-glucose-monitors",
        "icon": "water_drop_rounded"
      },
      {
        "nameAr": "موازين الحرارة",
        "nameEn": "Thermometers",
        "slug": "thermometers",
        "icon": "device_thermostat_rounded"
      },
      {
        "nameAr": "أجهزة قياس الأكسجين",
        "nameEn": "Pulse Oximeters",
        "slug": "pulse-oximeters",
        "icon": "monitor_heart_rounded"
      },
      {
        "nameAr": "مستلزمات الإسعافات الأولية",
        "nameEn": "First Aid Supplies",
        "slug": "first-aid",
        "icon": "medical_services_rounded"
      },
      {
        "nameAr": "المستهلكات الطبية",
        "nameEn": "Medical Consumables",
        "slug": "medical-supplies",
        "icon": "vaccines_rounded"
      },
      {
        "nameAr": "وسائل المساعدة على الحركة والمشي",
        "nameEn": "Mobility & Walking Aids",
        "slug": "mobility-support",
        "icon": "accessible_rounded"
      },
      {
        "nameAr": "الدعامات والمساند الطبية",
        "nameEn": "Orthopedic Supports & Braces",
        "slug": "orthopedic-supports-braces",
        "icon": "accessibility_new_rounded"
      },
      {
        "nameAr": "الكراسي المتحركة ومعدات التنقل",
        "nameEn": "Wheelchairs & Mobility Equipment",
        "slug": "wheelchairs-mobility-equipment",
        "icon": "accessible_forward_rounded"
      },
      {
        "nameAr": "مستلزمات العناية بالبصر",
        "nameEn": "Vision Care Accessories",
        "slug": "vision-care",
        "icon": "visibility_rounded"
      },
      {
        "nameAr": "أجهزة ومستلزمات السمع",
        "nameEn": "Hearing Care Devices & Accessories",
        "slug": "hearing-care-devices",
        "icon": "hearing_rounded"
      },
      {
        "nameAr": "منتجات العناية بالأسنان",
        "nameEn": "Dental Care Products",
        "slug": "dental-care",
        "icon": "health_and_safety_rounded"
      },
      {
        "nameAr": "أجهزة العناية بالصحة والرفاهية",
        "nameEn": "Personal Wellness Equipment",
        "slug": "personal-wellness-equipment",
        "icon": "spa_rounded"
      },
      {
        "nameAr": "أجهزة التدليك والاسترخاء",
        "nameEn": "Massage & Relaxation Equipment",
        "slug": "massage-relaxation-equipment",
        "icon": "self_improvement_rounded"
      },
      {
        "nameAr": "منتجات التغذية والعافية",
        "nameEn": "Nutrition & Wellness Products",
        "slug": "vitamins-supplements",
        "icon": "medication_rounded"
      },
      {
        "nameAr": "مستلزمات متابعة المؤشرات الصحية",
        "nameEn": "Health Monitoring Accessories",
        "slug": "health-monitoring-accessories",
        "icon": "monitor_heart_rounded"
      },
      {
        "nameAr": "أخرى",
        "nameEn": "Other",
        "slug": "other-health-wellness",
        "icon": "more_horiz_rounded"
      }
    ]
  },
  {
    "nameAr": "المنتجات الرقمية وبطاقات الهدايا",
    "nameEn": "Digital Products & Gift Cards",
    "slug": "digital-gift-cards",
    "icon": "confirmation_number_rounded",
    "image": "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=800&q=80",
    "sortOrder": 20,
    "subcategories": [
      {
        "nameAr": "شحن رصيد الهاتف",
        "nameEn": "Mobile Recharge",
        "slug": "mobile-recharge",
        "icon": "phonelink_ring_rounded"
      },
      {
        "nameAr": "باقات الإنترنت",
        "nameEn": "Internet Packages",
        "slug": "internet-packages",
        "icon": "wifi_rounded"
      },
      {
        "nameAr": "بطاقات الهدايا الرقمية",
        "nameEn": "Digital Gift Cards",
        "slug": "gift-cards",
        "icon": "redeem_rounded"
      },
      {
        "nameAr": "بطاقات شحن الألعاب",
        "nameEn": "Gaming Gift Cards",
        "slug": "gaming-gift-cards",
        "icon": "sports_esports_rounded"
      },
      {
        "nameAr": "الاشتراكات الرقمية",
        "nameEn": "Digital Subscriptions",
        "slug": "digital-subscriptions",
        "icon": "subscriptions_rounded"
      },
      {
        "nameAr": "البرامج والتراخيص الرقمية",
        "nameEn": "Software & Digital Licenses",
        "slug": "software-licenses",
        "icon": "terminal_rounded"
      },
      {
        "nameAr": "أخرى",
        "nameEn": "Other",
        "slug": "other-digital-products",
        "icon": "more_horiz_rounded"
      }
    ]
  }
];

export async function seedCategoriesCatalog(prismaClient?: PrismaClient) {
  const p = prismaClient || new PrismaClient();
  console.log('🌿 Seeding complete category & subcategory catalog for Souqnaa (20 approved main categories)...');

  // 1. Migrate legacy slug 'home-kitchen' to 'home-furniture' if present
  const legacyHomeKitchen = await p.category.findUnique({ where: { slug: 'home-kitchen' } });
  if (legacyHomeKitchen) {
    console.log("🔄 Migrating legacy 'home-kitchen' category to 'home-furniture'...");
    await p.category.update({
      where: { slug: 'home-kitchen' },
      data: {
        slug: 'home-furniture',
        nameAr: 'المنزل والأثاث',
        nameEn: 'Home & Furniture',
        icon: 'chair_rounded',
        sortOrder: 4,
      },
    });
  }

  // 2. Migrate legacy 'tools-hardware-construction' to 'tools-hardware' if present
  const legacyToolsConstruction = await p.category.findUnique({ where: { slug: 'tools-hardware-construction' } });
  if (legacyToolsConstruction) {
    console.log("🔄 Migrating legacy 'tools-hardware-construction' category to 'tools-hardware'...");
    await p.category.update({
      where: { slug: 'tools-hardware-construction' },
      data: {
        slug: 'tools-hardware',
        nameAr: 'الأدوات والمعدات',
        nameEn: 'Tools & Hardware',
        icon: 'build_rounded',
        sortOrder: 11,
      },
    });
  }

  // 3. Migrate legacy 'solar-energy-supplies' to 'solar-energy-power-equipment' if present
  const legacySolar = await p.category.findUnique({ where: { slug: 'solar-energy-supplies' } });
  if (legacySolar) {
    console.log("🔄 Migrating legacy 'solar-energy-supplies' to 'solar-energy-power-equipment'...");
    await p.category.update({
      where: { slug: 'solar-energy-supplies' },
      data: {
        slug: 'solar-energy-power-equipment',
        nameAr: 'الطاقة الشمسية ومعدات الطاقة',
        nameEn: 'Solar Energy & Power Equipment',
        icon: 'solar_power_rounded',
        sortOrder: 7,
      },
    });
  }

  const seededCategories: Record<string, any> = {};

  // 4. Seed all 20 approved root categories
  for (const rootCat of catalogCategories) {
    const root = await p.category.upsert({
      where: { slug: rootCat.slug },
      update: {
        nameAr: rootCat.nameAr,
        nameEn: rootCat.nameEn,
        icon: rootCat.icon,
        image: rootCat.image,
        sortOrder: rootCat.sortOrder,
        parentId: null,
        isActive: true,
      },
      create: {
        nameAr: rootCat.nameAr,
        nameEn: rootCat.nameEn,
        slug: rootCat.slug,
        icon: rootCat.icon,
        image: rootCat.image,
        sortOrder: rootCat.sortOrder,
        parentId: null,
        isActive: true,
      },
    });
    seededCategories[rootCat.slug] = root;

    let subOrder = 1;
    for (const sub of rootCat.subcategories) {
      const createdSub = await p.category.upsert({
        where: { slug: sub.slug },
        update: {
          nameAr: sub.nameAr,
          nameEn: sub.nameEn,
          icon: sub.icon,
          sortOrder: subOrder,
          parentId: root.id,
          isActive: true,
        },
        create: {
          nameAr: sub.nameAr,
          nameEn: sub.nameEn,
          slug: sub.slug,
          icon: sub.icon,
          sortOrder: subOrder,
          parentId: root.id,
          isActive: true,
        },
      });
      seededCategories[sub.slug] = createdSub;
      subOrder++;
    }
  }

  // 5. Handle legacy 'traditional-attire-heritage' category safely
  const legacyHeritage = await p.category.findUnique({ where: { slug: 'traditional-attire-heritage' } });
  if (legacyHeritage) {
    console.log("🔄 Reassigning legacy subcategories to 'fashion' and deactivating redundant root...");
    const fashionRoot = seededCategories['fashion'];
    if (fashionRoot) {
      await p.category.updateMany({
        where: { parentId: legacyHeritage.id },
        data: { parentId: fashionRoot.id },
      });
    }
    await p.category.update({
      where: { id: legacyHeritage.id },
      data: { isActive: false },
    });
  }

  // 6. Safely migrate & deactivate duplicate subcategories in the database
  const duplicateLegacySubcategories: { oldSlug: string; targetSlug: string }[] = [
    { oldSlug: 'tvs-monitors', targetSlug: 'televisions' },
    { oldSlug: 'audio-headphones', targetSlug: 'headphones-speakers' },
    { oldSlug: 'jewelry', targetSlug: 'gold-jewelry' },
    { oldSlug: 'diapers-baby-care', targetSlug: 'baby-care-products' },
    { oldSlug: 'building-materials', targetSlug: 'cement-building-supplies' },
    { oldSlug: 'electrical-supplies', targetSlug: 'electrical-building-supplies' },
    { oldSlug: 'tv-monitor-spare-parts', targetSlug: 'electronic-spare-parts' },
    { oldSlug: 'hard-drives-hdd-ssd', targetSlug: 'hard-disk-drives' },
    { oldSlug: 'engines-batteries', targetSlug: 'car-engines' },
    { oldSlug: 'football-team-sports', targetSlug: 'football-equipment' },
    { oldSlug: 'door-installation-supplies', targetSlug: 'door-handles-accessories' },
    { oldSlug: 'janabiya-sheaths', targetSlug: 'janabiya' },
    { oldSlug: 'janabiya-accessories', targetSlug: 'janabiya-belts' },
    { oldSlug: 'yemeni-traditional-belts', targetSlug: 'janabiya-belts' },
    { oldSlug: 'networking-routers', targetSlug: 'internet-routers' },
    { oldSlug: 'medical-equipment', targetSlug: 'medical-devices-equipment' },
    { oldSlug: 'baby-health', targetSlug: 'health-care-products' },
    { oldSlug: 'yemeni-traditional-attire', targetSlug: 'traditional-yemeni-clothing' },
    { oldSlug: 'folk-costume-supplies', targetSlug: 'traditional-yemeni-clothing' },
    { oldSlug: 'poultry-livestock-supplies', targetSlug: 'poultry-supplies' },
    { oldSlug: 'traditional-products', targetSlug: 'yemeni-handicrafts' },
  ];

  console.log('🧹 Cleaning up duplicate subcategories in database...');
  for (const { oldSlug, targetSlug } of duplicateLegacySubcategories) {
    const oldCat = await p.category.findUnique({ where: { slug: oldSlug } });
    if (oldCat) {
      const targetCat = seededCategories[targetSlug] || await p.category.findUnique({ where: { slug: targetSlug } });
      if (targetCat) {
        // Reassign any products pointing to old category
        await p.product.updateMany({
          where: { categoryId: oldCat.id },
          data: { categoryId: targetCat.id },
        });
      }
      // Deactivate the duplicate subcategory record so it no longer appears in queries
      await p.category.update({
        where: { id: oldCat.id },
        data: { isActive: false },
      });
      console.log(`  ✓ Deactivated duplicate subcategory '${oldSlug}' -> mapped to '${targetSlug}'`);
    }
  }

  const totalSubcategories = catalogCategories.reduce(
    (sum, cat) => sum + cat.subcategories.length,
    0,
  );
  console.log(
    `✓ Completed catalog seeding: ${catalogCategories.length} root categories and ${totalSubcategories} subcategories (all with universal Other option and suitable icons).`,
  );
  try {
    const { redis } = await import('./redis');
    await redis.delPattern('cache:home:feed*');
    console.log('  ✓ Invalidated home feed cache in Redis.');
  } catch (_) {}

  return seededCategories;
}

if (require.main === module) {
  const prisma = new PrismaClient();
  seedCategoriesCatalog(prisma)
    .catch((e) => {
      console.error('Category seeding error:', e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

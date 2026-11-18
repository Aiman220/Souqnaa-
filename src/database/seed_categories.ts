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
    nameAr: 'الإلكترونيات والتقنية',
    nameEn: 'Electronics & Technology',
    slug: 'electronics',
    icon: 'devices_rounded',
    image: 'https://images.unsplash.com/photo-1498049794561-7780e7231661?w=800&q=80',
    sortOrder: 1,
    subcategories: [
      { nameAr: 'الهواتف الذكية', nameEn: 'Mobile Phones & Smartphones', slug: 'mobile-phones-smartphones', icon: 'smartphone_rounded' },
      { nameAr: 'الأجهزة اللوحية', nameEn: 'Tablets & iPads', slug: 'tablets-ipads', icon: 'tablet_mac_rounded' },
      { nameAr: 'إكسسوارات الهواتف', nameEn: 'Mobile Accessories', slug: 'mobile-accessories', icon: 'cable_rounded' },
      { nameAr: 'اللابتوبات والحواسيب', nameEn: 'Laptops & Computers', slug: 'laptops-computers', icon: 'laptop_mac_rounded' },
      { nameAr: 'ملحقات الحاسوب', nameEn: 'Computer Accessories', slug: 'computer-accessories', icon: 'mouse_rounded' },
      { nameAr: 'مودمات الإنترنت وأجهزة الراوتر', nameEn: 'Internet Modems & Routers', slug: 'networking-routers', icon: 'router_rounded' },
      { nameAr: 'التلفزيونات والشاشات', nameEn: 'TVs & Monitors', slug: 'tvs-monitors', icon: 'tv_rounded' },
      { nameAr: 'الصوتيات والسماعات', nameEn: 'Audio & Headphones', slug: 'audio-headphones', icon: 'headphones_rounded' },
      { nameAr: 'الكاميرات والتصوير', nameEn: 'Cameras & Photography', slug: 'cameras-photography', icon: 'photo_camera_rounded' },
      { nameAr: 'الألعاب وأجهزة الألعاب', nameEn: 'Gaming & Consoles', slug: 'gaming-consoles', icon: 'sports_esports_rounded' },
      { nameAr: 'أجهزة المنزل الذكي', nameEn: 'Smart Home Devices', slug: 'smart-home-devices', icon: 'sensors_rounded' },
      { nameAr: 'قطع غيار الهواتف', nameEn: 'Phone Spare Parts', slug: 'phone-spare-parts', icon: 'phonelink_setup_rounded' },
      { nameAr: 'قطع غيار الحواسيب واللابتوبات', nameEn: 'Computer & Laptop Spare Parts', slug: 'computer-laptop-spare-parts', icon: 'developer_board_rounded' },
      { nameAr: 'قطع غيار الشاشات والتلفزيونات', nameEn: 'TV & Monitor Spare Parts', slug: 'tv-monitor-spare-parts', icon: 'display_settings_rounded' },
      { nameAr: 'قطع غيار الأجهزة الإلكترونية', nameEn: 'Electronic Device Spare Parts', slug: 'electronic-spare-parts', icon: 'memory_rounded' },
      { nameAr: 'الذواكر (RAM وMemory Cards)', nameEn: 'RAM & Memory Cards', slug: 'ram-memory-cards', icon: 'sd_storage_rounded' },
      { nameAr: 'وحدات USB والفلاشات', nameEn: 'USB & Flash Drives', slug: 'usb-flash-drives', icon: 'usb_rounded' },
      { nameAr: 'الأقراص الصلبة HDD وSSD', nameEn: 'Hard Drives (HDD & SSD)', slug: 'hard-drives-hdd-ssd', icon: 'storage_rounded' },
    ],
  },
  {
    nameAr: 'الأزياء والملابس',
    nameEn: 'Fashion & Clothing',
    slug: 'fashion',
    icon: 'checkroom_rounded',
    image: 'https://images.unsplash.com/photo-1445205170230-053b83016050?w=800&q=80',
    sortOrder: 2,
    subcategories: [
      { nameAr: 'ملابس رجالية', nameEn: "Men's Clothing", slug: 'mens-clothing', icon: 'man_rounded' },
      { nameAr: 'ملابس نسائية', nameEn: "Women's Clothing", slug: 'womens-clothing', icon: 'woman_rounded' },
      { nameAr: 'ملابس أطفال', nameEn: "Kids' Clothing", slug: 'kids-clothing', icon: 'child_care_rounded' },
      { nameAr: 'أحذية رجالية', nameEn: "Men's Shoes", slug: 'mens-shoes', icon: 'hiking_rounded' },
      { nameAr: 'أحذية نسائية', nameEn: "Women's Shoes", slug: 'womens-shoes', icon: 'shopping_bag_rounded' },
      { nameAr: 'أحذية أطفال', nameEn: "Kids' Shoes", slug: 'kids-shoes', icon: 'child_friendly_rounded' },
      { nameAr: 'الحقائب وحقائب الظهر', nameEn: 'Bags & Backpacks', slug: 'bags-backpacks', icon: 'backpack_rounded' },
      { nameAr: 'الساعات', nameEn: 'Watches', slug: 'watches', icon: 'watch_rounded' },
      { nameAr: 'المجوهرات', nameEn: 'Jewelry', slug: 'jewelry', icon: 'diamond_rounded' },
      { nameAr: 'إكسسوارات الأزياء', nameEn: 'Fashion Accessories', slug: 'fashion-accessories', icon: 'auto_awesome_rounded' },
      { nameAr: 'الملابس اليمنية التقليدية', nameEn: 'Traditional Yemeni Clothing', slug: 'traditional-yemeni-clothing', icon: 'dry_cleaning_rounded' },
    ],
  },
  {
    nameAr: 'الجمال والعناية الشخصية',
    nameEn: 'Beauty & Personal Care',
    slug: 'beauty',
    icon: 'spa_rounded',
    image: 'https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?w=800&q=80',
    sortOrder: 3,
    subcategories: [
      { nameAr: 'العناية بالبشرة', nameEn: 'Skincare', slug: 'skincare', icon: 'face_retouching_natural_rounded' },
      { nameAr: 'المكياج', nameEn: 'Makeup', slug: 'makeup', icon: 'brush_rounded' },
      { nameAr: 'العناية بالشعر', nameEn: 'Hair Care', slug: 'hair-care', icon: 'content_cut_rounded' },
      { nameAr: 'أدوات تصفيف الشعر', nameEn: 'Hair Styling Tools', slug: 'hair-styling-tools', icon: 'auto_fix_high_rounded' },
      { nameAr: 'العطور', nameEn: 'Perfumes & Fragrances', slug: 'perfumes-fragrances', icon: 'air_rounded' },
      { nameAr: 'العناية الشخصية للرجال', nameEn: "Men's Grooming", slug: 'mens-grooming', icon: 'face_rounded' },
      { nameAr: 'الاستحمام والعناية بالجسم', nameEn: 'Bath & Body', slug: 'bath-body', icon: 'bathtub_rounded' },
      { nameAr: 'النظافة الشخصية', nameEn: 'Personal Hygiene', slug: 'personal-hygiene', icon: 'clean_hands_rounded' },
    ],
  },
  {
    nameAr: 'المنزل والأثاث',
    nameEn: 'Home & Furniture',
    slug: 'home-furniture',
    icon: 'chair_rounded',
    image: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&q=80',
    sortOrder: 4,
    subcategories: [
      { nameAr: 'أثاث غرف المعيشة', nameEn: 'Living Room Furniture', slug: 'living-room-furniture', icon: 'weekend_rounded' },
      { nameAr: 'أثاث غرف النوم', nameEn: 'Bedroom Furniture', slug: 'bedroom-furniture', icon: 'bed_rounded' },
      { nameAr: 'أثاث المكاتب', nameEn: 'Office Furniture', slug: 'office-furniture', icon: 'desk_rounded' },
      { nameAr: 'ديكورات منزلية', nameEn: 'Home Decor', slug: 'home-decor', icon: 'auto_awesome_mosaic_rounded' },
      { nameAr: 'الإضاءة', nameEn: 'Lighting', slug: 'lighting', icon: 'lightbulb_rounded' },
      { nameAr: 'الستائر والسجاد', nameEn: 'Curtains & Carpets', slug: 'curtains-carpets', icon: 'texture_rounded' },
      { nameAr: 'المفروشات والمراتب', nameEn: 'Bedding & Mattresses', slug: 'bedding-mattresses', icon: 'hotel_rounded' },
      { nameAr: 'مستلزمات الحمام', nameEn: 'Bathroom Accessories', slug: 'bathroom-accessories', icon: 'shower_rounded' },
      { nameAr: 'التخزين والتنظيم', nameEn: 'Storage & Organization', slug: 'storage-organization', icon: 'inventory_2_rounded' },
    ],
  },
  {
    nameAr: 'الأجهزة المنزلية',
    nameEn: 'Home Appliances',
    slug: 'home-appliances',
    icon: 'kitchen_rounded',
    image: 'https://images.unsplash.com/photo-1556911220-e15b29be8c8f?w=800&q=80',
    sortOrder: 5,
    subcategories: [
      { nameAr: 'الثلاجات والفريزرات', nameEn: 'Refrigerators & Freezers', slug: 'refrigerators-freezers', icon: 'kitchen_rounded' },
      { nameAr: 'الغسالات والنشافات', nameEn: 'Washing Machines & Dryers', slug: 'washing-machines', icon: 'local_laundry_service_rounded' },
      { nameAr: 'المكيفات', nameEn: 'Air Conditioners', slug: 'air-conditioners', icon: 'ac_unit_rounded' },
      { nameAr: 'المراوح والشفاطات', nameEn: 'Fans & Exhaust Fans', slug: 'fans-heaters', icon: 'wind_power_rounded' },
      { nameAr: 'الأفران والطباخات', nameEn: 'Ovens & Cookers', slug: 'ovens-cookers', icon: 'countertops_rounded' },
      { nameAr: 'أجهزة المطبخ الصغيرة', nameEn: 'Small Kitchen Appliances', slug: 'kitchen-appliances', icon: 'coffee_maker_rounded' },
      { nameAr: 'الخلاطات والعصارات', nameEn: 'Blenders & Juicers', slug: 'blenders-juicers', icon: 'blender_rounded' },
      { nameAr: 'الميكروويف', nameEn: 'Microwaves', slug: 'microwaves', icon: 'microwave_rounded' },
      { nameAr: 'السخانات', nameEn: 'Heaters & Water Heaters', slug: 'heaters', icon: 'whatshot_rounded' },
      { nameAr: 'المكانس الكهربائية', nameEn: 'Vacuum Cleaners', slug: 'vacuum-cleaners', icon: 'cleaning_services_rounded' },
      { nameAr: 'برادات المياه', nameEn: 'Water Dispensers', slug: 'water-dispensers', icon: 'water_drop_rounded' },
      { nameAr: 'قطع غيار الأجهزة المنزلية', nameEn: 'Home Appliance Spare Parts', slug: 'home-appliance-spare-parts', icon: 'settings_rounded' },
    ],
  },
  {
    nameAr: 'السيارات والدراجات النارية',
    nameEn: 'Automotive & Motorcycles',
    slug: 'automotive-motorcycles',
    icon: 'directions_car_rounded',
    image: 'https://images.unsplash.com/photo-1486006920555-c77dce18193b?w=800&q=80',
    sortOrder: 6,
    subcategories: [
      { nameAr: 'قطع غيار السيارات', nameEn: 'Car Spare Parts', slug: 'car-spare-parts', icon: 'settings_applications_rounded' },
      { nameAr: 'قطع غيار الدراجات النارية', nameEn: 'Motorcycle Spare Parts', slug: 'motorcycle-spare-parts', icon: 'two_wheeler_rounded' },
      { nameAr: 'الدراجات النارية والكهربائية', nameEn: 'Motorcycles & Electric Bikes', slug: 'motorcycles-electric-bikes', icon: 'electric_moped_rounded' },
      { nameAr: 'الإطارات والعجلات', nameEn: 'Tires & Wheels', slug: 'tires-wheels', icon: 'tire_repair_rounded' },
      { nameAr: 'بطاريات السيارات', nameEn: 'Car Batteries', slug: 'car-batteries', icon: 'battery_charging_full_rounded' },
      { nameAr: 'المحركات والبطاريات', nameEn: 'Engines & Batteries', slug: 'engines-batteries', icon: 'ev_station_rounded' },
      { nameAr: 'زيوت ومستلزمات الصيانة', nameEn: 'Oils & Maintenance Supplies', slug: 'oils-fluids', icon: 'oil_barrel_rounded' },
      { nameAr: 'إلكترونيات السيارات', nameEn: 'Car Electronics', slug: 'car-electronics', icon: 'electric_car_rounded' },
      { nameAr: 'إكسسوارات السيارات', nameEn: 'Car Accessories', slug: 'car-accessories', icon: 'car_repair_rounded' },
      { nameAr: 'العناية بالسيارات', nameEn: 'Car Care & Cleaning', slug: 'car-care-cleaning', icon: 'local_car_wash_rounded' },
      { nameAr: 'إكسسوارات الدراجات النارية', nameEn: 'Motorcycle Accessories', slug: 'motorcycle-accessories', icon: 'moped_rounded' },
    ],
  },
  {
    nameAr: 'الرياضة والأنشطة الخارجية',
    nameEn: 'Sports & Outdoors',
    slug: 'sports',
    icon: 'sports_soccer_rounded',
    image: 'https://images.unsplash.com/photo-1461896836934-ffe607ba8211?w=800&q=80',
    sortOrder: 7,
    subcategories: [
      { nameAr: 'معدات اللياقة البدنية', nameEn: 'Fitness & Gym Equipment', slug: 'fitness-gym-equipment', icon: 'fitness_center_rounded' },
      { nameAr: 'كرة القدم والرياضات الجماعية', nameEn: 'Football & Team Sports', slug: 'football-team-sports', icon: 'sports_soccer_rounded' },
      { nameAr: 'الملابس الرياضية', nameEn: 'Sportswear', slug: 'sportswear', icon: 'sports_gymnastics_rounded' },
      { nameAr: 'الأحذية الرياضية', nameEn: 'Sports Shoes', slug: 'sports-shoes', icon: 'run_circle_rounded' },
      { nameAr: 'الدراجات الهوائية', nameEn: 'Bicycles', slug: 'bicycles', icon: 'pedal_bike_rounded' },
      { nameAr: 'التخييم والرحلات', nameEn: 'Camping & Hiking', slug: 'camping-hiking', icon: 'terrain_rounded' },
      { nameAr: 'مستلزمات الأنشطة الخارجية', nameEn: 'Outdoor Accessories', slug: 'outdoor-accessories', icon: 'backpack_rounded' },
    ],
  },
  {
    nameAr: 'الأطفال والألعاب',
    nameEn: 'Baby, Kids & Toys',
    slug: 'baby-kids-toys',
    icon: 'toys_rounded',
    image: 'https://images.unsplash.com/photo-1515488042361-ee00e0ddd4e4?w=800&q=80',
    sortOrder: 8,
    subcategories: [
      { nameAr: 'ملابس الرضع', nameEn: 'Baby Clothing', slug: 'baby-clothing', icon: 'child_care_rounded' },
      { nameAr: 'مستلزمات تغذية الأطفال', nameEn: 'Baby Feeding', slug: 'baby-feeding', icon: 'restaurant_rounded' },
      { nameAr: 'الحفاضات والعناية بالطفل', nameEn: 'Diapers & Baby Care', slug: 'diapers-baby-care', icon: 'sanitizer_rounded' },
      { nameAr: 'عربات ومقاعد الأطفال', nameEn: 'Strollers & Car Seats', slug: 'strollers-car-seats', icon: 'stroller_rounded' },
      { nameAr: 'الألعاب التعليمية', nameEn: 'Educational Toys', slug: 'educational-toys', icon: 'extension_rounded' },
      { nameAr: 'الدمى والشخصيات', nameEn: 'Dolls & Action Figures', slug: 'dolls-action-figures', icon: 'accessibility_new_rounded' },
      { nameAr: 'الألعاب الخارجية', nameEn: 'Outdoor Toys', slug: 'outdoor-toys', icon: 'sports_baseball_rounded' },
      { nameAr: 'أثاث الأطفال', nameEn: 'Baby Furniture', slug: 'baby-furniture', icon: 'crib_rounded' },
    ],
  },
  {
    nameAr: 'الكتب والقرطاسية والمكاتب',
    nameEn: 'Books, Stationery & Office',
    slug: 'books-stationery-office',
    icon: 'menu_book_rounded',
    image: 'https://images.unsplash.com/photo-1457369804613-52c61a468e7d?w=800&q=80',
    sortOrder: 9,
    subcategories: [
      { nameAr: 'الكتب والروايات', nameEn: 'Books & Novels', slug: 'books-novels', icon: 'auto_stories_rounded' },
      { nameAr: 'المستلزمات المدرسية', nameEn: 'School Supplies', slug: 'school-supplies', icon: 'school_rounded' },
      { nameAr: 'الدفاتر والأوراق', nameEn: 'Notebooks & Paper', slug: 'notebooks-paper', icon: 'note_alt_rounded' },
      { nameAr: 'الأقلام وأدوات الكتابة', nameEn: 'Pens & Writing Tools', slug: 'pens-writing-tools', icon: 'draw_rounded' },
      { nameAr: 'مستلزمات المكاتب', nameEn: 'Office Supplies', slug: 'office-supplies', icon: 'business_center_rounded' },
      { nameAr: 'الطابعات والماسحات', nameEn: 'Printers & Scanners', slug: 'printers-scanners', icon: 'print_rounded' },
      { nameAr: 'تقنيات المكاتب', nameEn: 'Office Technology', slug: 'office-technology', icon: 'devices_other_rounded' },
      { nameAr: 'مستلزمات الفنون والأشغال', nameEn: 'Art & Craft Supplies', slug: 'art-craft-supplies', icon: 'palette_rounded' },
    ],
  },
  {
    nameAr: 'الأدوات والبناء',
    nameEn: 'Tools, Hardware & Construction',
    slug: 'tools-hardware-construction',
    icon: 'build_rounded',
    image: 'https://images.unsplash.com/photo-1581783342308-f792dbdd27c5?w=800&q=80',
    sortOrder: 10,
    subcategories: [
      { nameAr: 'الأدوات اليدوية', nameEn: 'Hand Tools', slug: 'hand-tools', icon: 'handyman_rounded' },
      { nameAr: 'الأدوات الكهربائية', nameEn: 'Power Tools', slug: 'power-tools', icon: 'hardware_rounded' },
      { nameAr: 'مواد البناء', nameEn: 'Building Materials', slug: 'building-materials', icon: 'foundation_rounded' },
      { nameAr: 'المستلزمات الكهربائية', nameEn: 'Electrical Supplies', slug: 'electrical-supplies', icon: 'electrical_services_rounded' },
      { nameAr: 'مستلزمات السباكة', nameEn: 'Plumbing Supplies', slug: 'plumbing-supplies', icon: 'plumbing_rounded' },
      { nameAr: 'الدهانات والطلاءات', nameEn: 'Paints & Coatings', slug: 'paints-coatings', icon: 'format_paint_rounded' },
      { nameAr: 'معدات السلامة', nameEn: 'Safety Equipment', slug: 'safety-equipment', icon: 'security_rounded' },
      { nameAr: 'الأقفال والأمن', nameEn: 'Locks & Security', slug: 'locks-security', icon: 'lock_rounded' },
      { nameAr: 'الأبواب الخشبية', nameEn: 'Wooden Doors', slug: 'wooden-doors', icon: 'door_front_door_rounded' },
      { nameAr: 'الأبواب الحديدية', nameEn: 'Iron & Steel Doors', slug: 'iron-steel-doors', icon: 'door_back_door_rounded' },
      { nameAr: 'الأبواب الألمنيوم', nameEn: 'Aluminum Doors', slug: 'aluminum-doors', icon: 'door_sliding_rounded' },
      { nameAr: 'الأبواب البلاستيكية', nameEn: 'PVC & Plastic Doors', slug: 'plastic-pvc-doors', icon: 'meeting_room_rounded' },
      { nameAr: 'إكسسوارات ومقابض الأبواب', nameEn: 'Door Handles & Accessories', slug: 'door-handles-accessories', icon: 'key_rounded' },
      { nameAr: 'الأقفال والمفصلات', nameEn: 'Locks & Hinges', slug: 'locks-hinges', icon: 'lock_rounded' },
      { nameAr: 'مستلزمات تركيب الأبواب', nameEn: 'Door Installation Supplies', slug: 'door-installation-supplies', icon: 'carpenter_rounded' },
    ],
  },
  {
    nameAr: 'الحدائق والزراعة',
    nameEn: 'Garden & Agriculture',
    slug: 'garden-agriculture',
    icon: 'yard_rounded',
    image: 'https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=800&q=80',
    sortOrder: 11,
    subcategories: [
      { nameAr: 'النباتات والبذور', nameEn: 'Plants & Seeds', slug: 'plants-seeds', icon: 'grass_rounded' },
      { nameAr: 'أدوات الحدائق', nameEn: 'Gardening Tools', slug: 'gardening-tools', icon: 'agriculture_rounded' },
      { nameAr: 'معدات الري', nameEn: 'Irrigation Equipment', slug: 'irrigation-equipment', icon: 'water_drop_rounded' },
      { nameAr: 'الأسمدة والتربة', nameEn: 'Fertilizers & Soil', slug: 'fertilizers-soil', icon: 'eco_rounded' },
      { nameAr: 'المعدات الزراعية', nameEn: 'Agricultural Equipment', slug: 'agricultural-equipment', icon: 'precision_manufacturing_rounded' },
      { nameAr: 'مستلزمات المواشي والدواجن', nameEn: 'Poultry & Livestock Supplies', slug: 'poultry-livestock-supplies', icon: 'pets_rounded' },
    ],
  },
  {
    nameAr: 'الأعمال والمعدات الصناعية',
    nameEn: 'Business & Industrial',
    slug: 'business-industrial',
    icon: 'precision_manufacturing_rounded',
    image: 'https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=800&q=80',
    sortOrder: 12,
    subcategories: [
      { nameAr: 'المعدات التجارية', nameEn: 'Commercial Equipment', slug: 'commercial-equipment', icon: 'storefront_rounded' },
      { nameAr: 'الآلات الصناعية', nameEn: 'Industrial Machinery', slug: 'industrial-machinery', icon: 'factory_rounded' },
      { nameAr: 'معدات المطاعم', nameEn: 'Restaurant Equipment', slug: 'restaurant-equipment', icon: 'restaurant_rounded' },
      { nameAr: 'معدات الورش', nameEn: 'Workshop Equipment', slug: 'workshop-equipment', icon: 'construction_rounded' },
      { nameAr: 'مستلزمات التعبئة والتغليف', nameEn: 'Packaging Supplies', slug: 'packaging-supplies', icon: 'inventory_rounded' },
      { nameAr: 'مستلزمات الجملة', nameEn: 'Wholesale Supplies', slug: 'wholesale-supplies', icon: 'all_inbox_rounded' },
    ],
  },
  {
    nameAr: 'الهدايا والحرف والمنتجات التقليدية',
    nameEn: 'Gifts, Crafts & Traditional Products',
    slug: 'gifts-crafts-traditional',
    icon: 'card_giftcard_rounded',
    image: 'https://images.unsplash.com/photo-1513519245088-0e12902e5a38?w=800&q=80',
    sortOrder: 13,
    subcategories: [
      { nameAr: 'الهدايا', nameEn: 'Gift Items', slug: 'gift-items', icon: 'card_giftcard_rounded' },
      { nameAr: 'المنتجات اليدوية', nameEn: 'Handmade Products', slug: 'handmade-products', icon: 'interests_rounded' },
      { nameAr: 'الحرف اليمنية', nameEn: 'Yemeni Handicrafts', slug: 'yemeni-handicrafts', icon: 'workspace_premium_rounded' },
      { nameAr: 'الفضة التقليدية', nameEn: 'Traditional Silver Jewelry', slug: 'traditional-silver-jewelry', icon: 'diamond_rounded' },
      { nameAr: 'العسل اليمني', nameEn: 'Yemeni Honey', slug: 'yemeni-honey', icon: 'hive_rounded' },
      { nameAr: 'المنتجات التراثية', nameEn: 'Traditional Products', slug: 'traditional-products', icon: 'museum_rounded' },
      { nameAr: 'التذكارات', nameEn: 'Souvenirs', slug: 'souvenirs', icon: 'celebration_rounded' },
    ],
  },
  {
    nameAr: 'المنتجات الرقمية وبطاقات الهدايا',
    nameEn: 'Digital Products & Gift Cards',
    slug: 'digital-gift-cards',
    icon: 'confirmation_number_rounded',
    image: 'https://images.unsplash.com/photo-1563013544-824ae1b704d3?w=800&q=80',
    sortOrder: 14,
    subcategories: [
      { nameAr: 'شحن الرصيد', nameEn: 'Mobile Recharge', slug: 'mobile-recharge', icon: 'phonelink_ring_rounded' },
      { nameAr: 'باقات الإنترنت', nameEn: 'Internet Packages', slug: 'internet-packages', icon: 'wifi_rounded' },
      { nameAr: 'بطاقات الهدايا', nameEn: 'Gift Cards', slug: 'gift-cards', icon: 'redeem_rounded' },
      { nameAr: 'بطاقات الألعاب', nameEn: 'Gaming Gift Cards', slug: 'gaming-gift-cards', icon: 'sports_esports_rounded' },
      { nameAr: 'الاشتراكات الرقمية', nameEn: 'Digital Subscriptions', slug: 'digital-subscriptions', icon: 'subscriptions_rounded' },
      { nameAr: 'البرامج والتراخيص', nameEn: 'Software & Licenses', slug: 'software-licenses', icon: 'terminal_rounded' },
    ],
  },
  {
    nameAr: 'الطاقة الشمسية ومستلزماتها',
    nameEn: 'Solar Energy & Supplies',
    slug: 'solar-energy-supplies',
    icon: 'solar_power_rounded',
    image: 'https://images.unsplash.com/photo-1509391366360-2e959784a276?w=800&q=80',
    sortOrder: 15,
    subcategories: [
      { nameAr: 'ألواح الطاقة الشمسية', nameEn: 'Solar Panels', slug: 'solar-panels', icon: 'solar_power_rounded' },
      { nameAr: 'بطاريات الطاقة الشمسية', nameEn: 'Solar Batteries', slug: 'solar-batteries', icon: 'battery_charging_full_rounded' },
      { nameAr: 'الإنفرترات ومحولات الطاقة', nameEn: 'Inverters & Power Converters', slug: 'inverters-power-converters', icon: 'electric_bolt_rounded' },
      { nameAr: 'منظمات الشحن', nameEn: 'Charge Controllers', slug: 'charge-controllers', icon: 'electric_meter_rounded' },
      { nameAr: 'كابلات وأسلاك الطاقة الشمسية', nameEn: 'Solar Cables & Wires', slug: 'solar-cables-wires', icon: 'cable_rounded' },
      { nameAr: 'هياكل وقواعد تثبيت الألواح', nameEn: 'Solar Mounting Structures & Racks', slug: 'solar-mounting-structures', icon: 'roofing_rounded' },
      { nameAr: 'قواطع وفيوزات وحمايات كهربائية', nameEn: 'Circuit Breakers, Fuses & Electrical Protection', slug: 'circuit-breakers-fuses-protection', icon: 'shield_rounded' },
      { nameAr: 'إكسسوارات ومستلزمات التركيب', nameEn: 'Solar Installation Accessories', slug: 'solar-installation-accessories', icon: 'settings_input_component_rounded' },
      { nameAr: 'أنظمة الطاقة الشمسية المتكاملة', nameEn: 'Complete Solar Energy Systems', slug: 'complete-solar-systems', icon: 'energy_savings_leaf_rounded' },
    ],
  },
  {
    nameAr: 'الأزياء والمنتجات التراثية',
    nameEn: 'Traditional Attire & Heritage Products',
    slug: 'traditional-attire-heritage',
    icon: 'workspace_premium_rounded',
    image: 'https://images.unsplash.com/photo-1590073242678-70ee3fc28e8e?w=800&q=80',
    sortOrder: 16,
    subcategories: [
      { nameAr: 'العُصُب ومستلزماتها', nameEn: 'Asib (Janabiya Belts) & Supplies', slug: 'asib-supplies', icon: 'style_rounded' },
      { nameAr: 'الجنابي', nameEn: 'Janabiya (Traditional Daggers)', slug: 'janabiya', icon: 'military_tech_rounded' },
      { nameAr: 'أحزمة الجنابي', nameEn: 'Janabiya Belts', slug: 'janabiya-belts', icon: 'texture_rounded' },
      { nameAr: 'أغمدة الجنابي', nameEn: 'Janabiya Sheaths', slug: 'janabiya-sheaths', icon: 'cases_rounded' },
      { nameAr: 'إكسسوارات الجنابي', nameEn: 'Janabiya Accessories', slug: 'janabiya-accessories', icon: 'diamond_rounded' },
      { nameAr: 'الملابس والأزياء اليمنية التقليدية', nameEn: 'Traditional Yemeni Clothing & Attire', slug: 'yemeni-traditional-attire', icon: 'checkroom_rounded' },
      { nameAr: 'مستلزمات الزي الشعبي', nameEn: 'Traditional Folk Costume Supplies', slug: 'folk-costume-supplies', icon: 'dry_cleaning_rounded' },
    ],
  },
  {
    nameAr: 'أجهزة المراقبة والحماية',
    nameEn: 'Surveillance & Security Systems',
    slug: 'surveillance-security',
    icon: 'security_rounded',
    image: 'https://images.unsplash.com/photo-1557597774-9d273605dfa9?w=800&q=80',
    sortOrder: 17,
    subcategories: [
      { nameAr: 'كاميرات المراقبة', nameEn: 'Security & CCTV Cameras', slug: 'security-cameras', icon: 'camera_outdoor_rounded' },
      { nameAr: 'أجهزة DVR وNVR', nameEn: 'DVR & NVR Recorders', slug: 'dvr-nvr-recorders', icon: 'dvr_rounded' },
      { nameAr: 'أنظمة المراقبة المتكاملة', nameEn: 'Complete Surveillance Systems', slug: 'complete-surveillance-systems', icon: 'linked_camera_rounded' },
      { nameAr: 'أجهزة الإنذار والحماية', nameEn: 'Alarm & Protection Systems', slug: 'alarm-protection-systems', icon: 'crisis_alert_rounded' },
      { nameAr: 'أجهزة التحكم بالدخول', nameEn: 'Access Control Systems', slug: 'access-control-systems', icon: 'sensor_door_rounded' },
      { nameAr: 'أجهزة البصمة', nameEn: 'Fingerprint & Biometric Devices', slug: 'fingerprint-biometric-devices', icon: 'fingerprint_rounded' },
      { nameAr: 'حساسات الحركة', nameEn: 'Motion Sensors', slug: 'motion-sensors', icon: 'sensors_rounded' },
      { nameAr: 'أقفال وأنظمة الحماية الذكية', nameEn: 'Smart Locks & Security Systems', slug: 'smart-locks-security', icon: 'phonelink_lock_rounded' },
      { nameAr: 'كابلات وملحقات كاميرات المراقبة', nameEn: 'CCTV Cables & Accessories', slug: 'cctv-cables-accessories', icon: 'cable_rounded' },
    ],
  },
  {
    nameAr: 'الصحة والعناية الصحية',
    nameEn: 'Health & Wellness',
    slug: 'health-wellness',
    icon: 'health_and_safety_rounded',
    image: 'https://images.unsplash.com/photo-1505751172876-fa1923c5c528?w=800&q=80',
    sortOrder: 18,
    subcategories: [
      { nameAr: 'الفيتامينات والمكملات', nameEn: 'Vitamins & Supplements', slug: 'vitamins-supplements', icon: 'medication_rounded' },
      { nameAr: 'الأجهزة الطبية', nameEn: 'Medical Equipment', slug: 'medical-equipment', icon: 'monitor_heart_rounded' },
      { nameAr: 'الإسعافات الأولية', nameEn: 'First Aid', slug: 'first-aid', icon: 'medical_services_rounded' },
      { nameAr: 'المستلزمات الطبية', nameEn: 'Medical Supplies', slug: 'medical-supplies', icon: 'vaccines_rounded' },
      { nameAr: 'أدوات الحركة والدعم', nameEn: 'Mobility & Support', slug: 'mobility-support', icon: 'accessible_rounded' },
      { nameAr: 'العناية بالأسنان', nameEn: 'Dental Care', slug: 'dental-care', icon: 'sentiment_very_satisfied_rounded' },
      { nameAr: 'العناية بالبصر', nameEn: 'Vision Care', slug: 'vision-care', icon: 'visibility_rounded' },
      { nameAr: 'صحة الطفل', nameEn: 'Baby Health', slug: 'baby-health', icon: 'child_care_rounded' },
    ],
  },
];

export async function seedCategoriesCatalog(prismaClient?: PrismaClient) {
  const p = prismaClient || new PrismaClient();
  console.log('🌿 Seeding complete category & subcategory catalog for Souqnaa...');

  // 1. Check for legacy slug 'home-kitchen' and migrate to 'home-furniture' if present
  const legacyHomeKitchen = await p.category.findUnique({ where: { slug: 'home-kitchen' } });
  if (legacyHomeKitchen) {
    console.log(`🔄 Migrating legacy 'home-kitchen' category to 'home-furniture'...`);
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

  const seededCategories: Record<string, any> = {};

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

  const totalSubcategories = catalogCategories.reduce(
    (sum, cat) => sum + cat.subcategories.length,
    0,
  );
  console.log(
    `✓ Completed catalog seeding: ${catalogCategories.length} root categories and ${totalSubcategories} subcategories.`,
  );
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


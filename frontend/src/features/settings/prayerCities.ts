/** A short list of cities for choosing a place without typing coordinates. Loaded only when the prayer settings open. [id, English, Arabic, Dutch, latitude, longitude, country]. */
export type City = { id: string; names: [string, string, string]; lat: number; lng: number; country: string }
const ROWS: [string, string, string, string, number, number, string][] = [
  ['makkah', 'Makkah', 'مكة المكرمة', 'Mekka', 21.4225, 39.8262, 'SA'], ['madinah', 'Madinah', 'المدينة المنورة', 'Medina', 24.4672, 39.6111, 'SA'],
  ['riyadh', 'Riyadh', 'الرياض', 'Riyad', 24.7136, 46.6753, 'SA'], ['jeddah', 'Jeddah', 'جدة', 'Jeddah', 21.4858, 39.1925, 'SA'],
  ['dammam', 'Dammam', 'الدمام', 'Dammam', 26.4207, 50.0888, 'SA'], ['dubai', 'Dubai', 'دبي', 'Dubai', 25.2048, 55.2708, 'AE'],
  ['abudhabi', 'Abu Dhabi', 'أبوظبي', 'Abu Dhabi', 24.4539, 54.3773, 'AE'], ['kuwait', 'Kuwait City', 'مدينة الكويت', 'Koeweit-Stad', 29.3759, 47.9774, 'KW'],
  ['doha', 'Doha', 'الدوحة', 'Doha', 25.2854, 51.531, 'QA'], ['manama', 'Manama', 'المنامة', 'Manama', 26.2285, 50.586, 'BH'],
  ['muscat', 'Muscat', 'مسقط', 'Muscat', 23.588, 58.3829, 'OM'], ['cairo', 'Cairo', 'القاهرة', 'Caïro', 30.0444, 31.2357, 'EG'],
  ['alexandria', 'Alexandria', 'الإسكندرية', 'Alexandrië', 31.2001, 29.9187, 'EG'], ['amman', 'Amman', 'عمّان', 'Amman', 31.9454, 35.9284, 'JO'],
  ['baghdad', 'Baghdad', 'بغداد', 'Bagdad', 33.3152, 44.3661, 'IQ'], ['damascus', 'Damascus', 'دمشق', 'Damascus', 33.5138, 36.2765, 'SY'],
  ['beirut', 'Beirut', 'بيروت', 'Beiroet', 33.8938, 35.5018, 'LB'], ['sanaa', 'Sanaa', 'صنعاء', 'Sanaa', 15.3694, 44.191, 'YE'],
  ['khartoum', 'Khartoum', 'الخرطوم', 'Khartoem', 15.5007, 32.5599, 'SD'], ['tripoli', 'Tripoli', 'طرابلس', 'Tripoli', 32.8872, 13.1913, 'LY'],
  ['tunis', 'Tunis', 'تونس', 'Tunis', 36.8065, 10.1815, 'TN'], ['algiers', 'Algiers', 'الجزائر', 'Algiers', 36.7538, 3.0588, 'DZ'],
  ['casablanca', 'Casablanca', 'الدار البيضاء', 'Casablanca', 33.5731, -7.5898, 'MA'], ['rabat', 'Rabat', 'الرباط', 'Rabat', 34.0209, -6.8416, 'MA'],
  ['istanbul', 'Istanbul', 'إسطنبول', 'Istanbul', 41.0082, 28.9784, 'TR'], ['ankara', 'Ankara', 'أنقرة', 'Ankara', 39.9334, 32.8597, 'TR'],
  ['amsterdam', 'Amsterdam', 'أمستردام', 'Amsterdam', 52.3676, 4.9041, 'NL'], ['rotterdam', 'Rotterdam', 'روتردام', 'Rotterdam', 51.9244, 4.4777, 'NL'],
  ['thehague', 'The Hague', 'لاهاي', 'Den Haag', 52.0705, 4.3007, 'NL'], ['utrecht', 'Utrecht', 'أوترخت', 'Utrecht', 52.0907, 5.1214, 'NL'],
  ['eindhoven', 'Eindhoven', 'أيندهوفن', 'Eindhoven', 51.4416, 5.4697, 'NL'], ['london', 'London', 'لندن', 'Londen', 51.5074, -0.1278, 'GB'],
  ['paris', 'Paris', 'باريس', 'Parijs', 48.8566, 2.3522, 'FR'], ['brussels', 'Brussels', 'بروكسل', 'Brussel', 50.8503, 4.3517, 'BE'],
  ['berlin', 'Berlin', 'برلين', 'Berlijn', 52.52, 13.405, 'DE'], ['newyork', 'New York', 'نيويورك', 'New York', 40.7128, -74.006, 'US'],
  ['toronto', 'Toronto', 'تورونتو', 'Toronto', 43.6532, -79.3832, 'CA'], ['karachi', 'Karachi', 'كراتشي', 'Karachi', 24.8607, 67.0011, 'PK'],
  ['jakarta', 'Jakarta', 'جاكرتا', 'Jakarta', -6.2088, 106.8456, 'ID'], ['kualalumpur', 'Kuala Lumpur', 'كوالالمبور', 'Kuala Lumpur', 3.139, 101.6869, 'MY'],
  ['dhaka', 'Dhaka', 'دكا', 'Dhaka', 23.8103, 90.4125, 'BD'], ['sydney', 'Sydney', 'سيدني', 'Sydney', -33.8688, 151.2093, 'AU'],
]
export const CITIES: City[] = ROWS.map(([id, en, ar, nl, lat, lng, country]) => ({ id, names: [en, ar, nl], lat, lng, country }))

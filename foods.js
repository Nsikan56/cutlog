/* Built-in whole foods. Values per 100 g, approximate (USDA FoodData Central).
   piece: grams in one typical item; cup: grams in one cup. fib100: fibre per 100 g (left out where it isn't clear, so it counts as unknown). */
const BUILTIN_FOODS = [
  {name:"Sweet potato (raw weight)", kcal100:86, pro100:1.6, fib100:3.0, piece:130, pieceLabel:"medium potato", cup:133, state:"raw", twin:"Sweet potato, baked", cook:true},
  {name:"Sweet potato, baked", kcal100:90, pro100:2.0, fib100:3.3, piece:115, pieceLabel:"medium potato", cup:200, state:"cooked", twin:"Sweet potato (raw weight)", cook:true},
  {name:"Potato, white (raw)", kcal100:77, pro100:2.0, fib100:2.1, piece:213, pieceLabel:"medium potato", state:"raw", twin:"Potato, white (boiled)", cook:true},
  {name:"Egg, large", kcal100:143, pro100:12.6, fib100:0, piece:50, pieceLabel:"egg", cook:true},
  {name:"Egg white, large", kcal100:52, pro100:10.9, fib100:0, piece:33, pieceLabel:"white", cup:243, cook:true},
  {name:"Ground chicken, extra lean (raw)", kcal100:140, pro100:20, fib100:0, state:"raw", twin:"Ground chicken, extra lean (cooked)", cook:true},
  {name:"Ground beef, extra lean (raw)", kcal100:137, pro100:21, fib100:0, state:"raw", twin:"Ground beef, extra lean (cooked)", cook:true},
  {name:"Chicken breast (raw)", kcal100:120, pro100:22.5, fib100:0, piece:200, pieceLabel:"breast", state:"raw", twin:"Chicken breast (cooked)", cook:true},
  {name:"Chicken breast (cooked)", kcal100:165, pro100:31, fib100:0, state:"cooked", twin:"Chicken breast (raw)", cook:true},
  {name:"Basa / swai fillet (raw)", kcal100:70, pro100:15, fib100:0, piece:150, pieceLabel:"fillet", state:"raw", twin:"Basa / swai fillet (cooked)", cook:true},
  {name:"Salmon, Atlantic (raw)", kcal100:208, pro100:20.4, fib100:0, piece:170, pieceLabel:"fillet", state:"raw", twin:"Salmon, cooked", cook:true},
  {name:"Tuna, canned in water (drained)", kcal100:116, pro100:25.5, fib100:0, piece:120, pieceLabel:"can"},
  {name:"Spinach (raw)", kcal100:23, pro100:2.9, fib100:2.2, cup:30, cook:true},
  {name:"Broccoli (raw)", kcal100:34, pro100:2.8, fib100:2.6, cup:91, cook:true},
  {name:"Mixed vegetables, frozen", kcal100:64, pro100:2.9, fib100:3.8, cup:135, cook:true},
  {name:"Banana", kcal100:89, pro100:1.1, fib100:2.6, piece:118, pieceLabel:"medium banana"},
  {name:"Blueberries", kcal100:57, pro100:0.7, fib100:2.4, cup:148},
  {name:"Apple", kcal100:52, pro100:0.3, fib100:2.4, piece:182, pieceLabel:"medium apple"},
  {name:"Avocado", kcal100:160, pro100:2.0, fib100:6.7, piece:150, pieceLabel:"avocado (flesh)"},
  {name:"Oats, rolled (dry)", kcal100:379, pro100:13.2, fib100:10.1, cup:80, state:"dry", twin:"Oatmeal, cooked with water"},
  {name:"White rice (cooked)", kcal100:130, pro100:2.7, fib100:0.4, cup:158, state:"cooked", twin:"White rice (dry)", cook:true},
  {name:"Brown rice (cooked)", kcal100:123, pro100:2.7, fib100:1.6, cup:195, state:"cooked", twin:"Brown rice (dry)", cook:true},
  {name:"Whole wheat bread", kcal100:247, pro100:13, fib100:6.0, piece:32, pieceLabel:"slice"},
  {name:"Greek yogurt, plain 0%", kcal100:59, pro100:10.3, fib100:0, cup:245},
  {name:"Cottage cheese, 2%", kcal100:84, pro100:11, fib100:0, cup:226},
  {name:"Milk, 2%", kcal100:50, pro100:3.3, fib100:0, cup:244},
  {name:"Peanut butter", kcal100:588, pro100:25, fib100:6.0},
  {name:"Olive oil", kcal100:884, pro100:0, fib100:0},
  {name:"Butter", kcal100:717, pro100:0.9, fib100:0},
  {name:"Cream cheese, light", kcal100:200, pro100:7.9, fib100:0},
].map((f,i)=>({...f, id:"b"+i, source:"built-in"}));


/* Common Nigerian foods. Typical home-cooked values per 100 g (estimates: oil and recipes vary). */
const NG_FOODS = [
  {name:"Jollof rice", alias:"jellof party rice nigerian", kcal100:170, pro100:3, piece:300, pieceLabel:"plate", cup:190},
  {name:"Fried rice (Nigerian)", alias:"party", kcal100:180, pro100:4, piece:300, pieceLabel:"plate", cup:190},
  {name:"White rice and stew", alias:"rice stew tomato", kcal100:155, pro100:2.8, piece:350, pieceLabel:"plate"},
  {name:"Ofada rice", alias:"brown local rice", kcal100:130, pro100:2.8, piece:300, pieceLabel:"plate", cup:190},
  {name:"Eba (garri)", alias:"swallow cassava", kcal100:160, pro100:0.6, piece:250, pieceLabel:"wrap (fist size)"},
  {name:"Garri, dry (for soaking)", alias:"gari cassava flakes", kcal100:360, pro100:1, cup:140},
  {name:"Pounded yam", alias:"iyan swallow", kcal100:118, pro100:1.5, piece:250, pieceLabel:"wrap (fist size)"},
  {name:"Amala", alias:"swallow yam flour elubo", kcal100:130, pro100:1.6, piece:250, pieceLabel:"wrap (fist size)"},
  {name:"Fufu (cassava)", alias:"akpu swallow", kcal100:150, pro100:0.8, piece:250, pieceLabel:"wrap (fist size)"},
  {name:"Semo (semolina swallow)", alias:"semovita swallow", kcal100:115, pro100:3.5, piece:250, pieceLabel:"wrap (fist size)"},
  {name:"Boiled yam", alias:"yam", kcal100:116, pro100:1.5, fib100:3.9, piece:100, pieceLabel:"slice"},
  {name:"Fried yam", alias:"dundun yam chips", kcal100:260, pro100:2, piece:40, pieceLabel:"chip"},
  {name:"Fried plantain (dodo)", alias:"dodo plantain", kcal100:230, pro100:1.5, piece:180, pieceLabel:"whole plantain"},
  {name:"Boiled plantain", alias:"plantain unripe", kcal100:116, pro100:0.8, fib100:2.3, piece:180, pieceLabel:"plantain"},
  {name:"Beans porridge (ewa)", alias:"ewa beans porridge agoyin", kcal100:150, pro100:7, cup:250},
  {name:"Moi moi", alias:"moimoi bean pudding", kcal100:150, pro100:8, piece:130, pieceLabel:"wrap"},
  {name:"Akara (bean fritters)", alias:"akara kosai bean cake", kcal100:300, pro100:12, piece:25, pieceLabel:"ball"},
  {name:"Egusi soup", alias:"melon soup", kcal100:220, pro100:10, piece:150, pieceLabel:"ladle"},
  {name:"Okra soup", alias:"okro ila", kcal100:90, pro100:5, piece:150, pieceLabel:"ladle"},
  {name:"Efo riro", alias:"vegetable soup spinach", kcal100:150, pro100:7, piece:150, pieceLabel:"ladle"},
  {name:"Ogbono soup", alias:"draw soup", kcal100:200, pro100:8, piece:150, pieceLabel:"ladle"},
  {name:"Pepper soup (goat or chicken)", alias:"peppersoup", kcal100:70, pro100:9, piece:350, pieceLabel:"bowl"},
  {name:"Tomato stew", alias:"obe ata stew sauce", kcal100:120, pro100:1.5, piece:100, pieceLabel:"ladle"},
  {name:"Suya (beef)", alias:"beef kebab", kcal100:230, pro100:28, piece:60, pieceLabel:"stick"},
  {name:"Fried chicken (Nigerian)", alias:"chicken", kcal100:250, pro100:25, piece:120, pieceLabel:"piece"},
  {name:"Fried fish (croaker or mackerel)", alias:"fish titus", kcal100:230, pro100:22, piece:150, pieceLabel:"piece"},
  {name:"Meat pie", alias:"pastry", kcal100:300, pro100:8, piece:150, pieceLabel:"pie"},
  {name:"Puff-puff", alias:"puff puff", kcal100:330, pro100:6, piece:25, pieceLabel:"ball"},
  {name:"Chin chin", alias:"chinchin snack", kcal100:480, pro100:8, piece:30, pieceLabel:"handful"},
  {name:"Indomie noodles (dry weight)", alias:"noodles instant", kcal100:437, pro100:8.6, piece:70, pieceLabel:"pack (70 g)"},
  {name:"Agege bread", alias:"bread", kcal100:270, pro100:8, piece:40, pieceLabel:"slice"},
  {name:"Pap / ogi (akamu)", alias:"pap ogi akamu custard", kcal100:50, pro100:0.5, cup:250},
  {name:"Groundnuts, roasted", alias:"peanuts", kcal100:585, pro100:24, fib100:8.4, piece:30, pieceLabel:"handful"},
  {name:"Zobo (sweetened)", alias:"hibiscus drink", kcal100:45, pro100:0, cup:250},
].map((f,i)=>({...f, id:"ng"+i, source:"built-in", est:true}));
BUILTIN_FOODS.push(...NG_FOODS);

/* Common dishes and takeout in Canada. Typical values per 100 g (estimates: recipes and portions vary). */
const CA_FOODS = [
  {name:"Poutine", alias:"fries gravy curds", kcal100:225, pro100:5.5, piece:400, pieceLabel:"regular"},
  {name:"Chicken shawarma wrap", alias:"shawarma pita", kcal100:220, pro100:12, piece:300, pieceLabel:"wrap"},
  {name:"Chicken shawarma plate", alias:"shawarma rice platter", kcal100:170, pro100:11, piece:550, pieceLabel:"plate"},
  {name:"Butter chicken", alias:"indian curry murgh makhani", kcal100:150, pro100:12, cup:240},
  {name:"Pizza, pepperoni", alias:"slice pie", kcal100:290, pro100:12, piece:110, pieceLabel:"slice"},
  {name:"Cheeseburger", alias:"burger hamburger", kcal100:260, pro100:14, piece:200, pieceLabel:"burger"},
  {name:"French fries", alias:"chips fries", kcal100:310, pro100:3.4, fib100:3.8, piece:150, pieceLabel:"medium"},
  {name:"Chicken wings", alias:"wings", kcal100:290, pro100:27, fib100:0, piece:35, pieceLabel:"wing"},
  {name:"Spaghetti with meat sauce", alias:"pasta bolognese", kcal100:150, pro100:7, cup:250},
  {name:"Pasta, cooked plain", alias:"spaghetti noodles", kcal100:158, pro100:5.8, fib100:1.8, cup:140, state:"cooked", twin:"Pasta (dry)", cook:true},
  {name:"Mac and cheese", alias:"macaroni kraft dinner kd", kcal100:165, pro100:6.5, cup:200},
  {name:"Chili con carne", alias:"chilli beef beans", kcal100:120, pro100:9, cup:255},
  {name:"Chicken stir fry", alias:"stirfry vegetables", kcal100:120, pro100:10, cup:200},
  {name:"Beef pho", alias:"pho noodle soup vietnamese", kcal100:60, pro100:4.5, piece:700, pieceLabel:"bowl"},
  {name:"Sushi, California roll", alias:"sushi maki", kcal100:150, pro100:4, piece:30, pieceLabel:"piece"},
  {name:"Chicken burrito", alias:"burrito wrap mexican", kcal100:200, pro100:10, piece:400, pieceLabel:"burrito"},
  {name:"Burrito bowl", alias:"rice bowl chipotle", kcal100:150, pro100:9, piece:500, pieceLabel:"bowl"},
  {name:"Chicken Caesar salad", alias:"caesar salad", kcal100:160, pro100:11, piece:300, pieceLabel:"salad"},
  {name:"Chicken noodle soup", alias:"soup", kcal100:35, pro100:2.5, cup:250},
  {name:"Roast chicken (with skin)", alias:"rotisserie chicken", kcal100:220, pro100:24, fib100:0, piece:100, pieceLabel:"palm-size piece"},
  {name:"Chicken thigh, cooked", alias:"thigh", kcal100:210, pro100:26, fib100:0, piece:85, pieceLabel:"thigh", cook:true},
  {name:"Steak, cooked", alias:"beef sirloin", kcal100:250, pro100:26, fib100:0, piece:225, pieceLabel:"8 oz steak", cook:true},
  {name:"Salmon, cooked", alias:"fish", kcal100:206, pro100:22, fib100:0, piece:150, pieceLabel:"fillet", state:"cooked", twin:"Salmon, Atlantic (raw)", cook:true},
  {name:"Mashed potatoes", alias:"potato mash", kcal100:110, pro100:2, cup:210},
  {name:"Pancakes", alias:"pancake", kcal100:230, pro100:6, piece:60, pieceLabel:"pancake"},
  {name:"Bagel, plain", alias:"bagel", kcal100:260, pro100:10, fib100:2.3, piece:105, pieceLabel:"bagel"},
  {name:"Muffin (bakery)", alias:"muffin blueberry", kcal100:380, pro100:6, piece:115, pieceLabel:"muffin"},
  {name:"Donut, glazed", alias:"doughnut", kcal100:420, pro100:5, piece:60, pieceLabel:"donut"},
  {name:"Breakfast sandwich (egg, cheese, sausage)", alias:"egg muffin breakfast", kcal100:280, pro100:13, piece:160, pieceLabel:"sandwich"},
  {name:"Bacon, cooked", alias:"bacon", kcal100:540, pro100:37, fib100:0, piece:8, pieceLabel:"slice"},
  {name:"Cheddar cheese", alias:"cheese", kcal100:400, pro100:25, fib100:0, piece:20, pieceLabel:"slice"},
  {name:"Granola bar", alias:"bar", kcal100:450, pro100:7, piece:30, pieceLabel:"bar"},
].map((f,i)=>({...f, id:"ca"+i, source:"built-in", est:true}));
BUILTIN_FOODS.push(...CA_FOODS);

/* Raw/cooked partners for the staples (v43). Kept in their own list at the end so no existing food changes its id,
   and so the cooked foods people log most stay first in search. USDA FoodData Central, per 100 g. */
const TWIN_FOODS = [
  {name:"Ground chicken, extra lean (cooked)", kcal100:180, pro100:26, fib100:0, state:"cooked", twin:"Ground chicken, extra lean (raw)", cook:true},
  {name:"Ground beef, extra lean (cooked)", kcal100:175, pro100:27, fib100:0, state:"cooked", twin:"Ground beef, extra lean (raw)", cook:true},
  {name:"Basa / swai fillet (cooked)", kcal100:90, pro100:19, fib100:0, piece:115, pieceLabel:"fillet", state:"cooked", twin:"Basa / swai fillet (raw)", cook:true},
  {name:"Potato, white (boiled)", kcal100:87, pro100:1.9, fib100:1.8, piece:170, pieceLabel:"medium potato", cup:156, state:"cooked", twin:"Potato, white (raw)", cook:true},
  {name:"White rice (dry)", alias:"uncooked raw", kcal100:365, pro100:7.1, fib100:1.3, cup:185, state:"dry", twin:"White rice (cooked)"},
  {name:"Brown rice (dry)", alias:"uncooked raw", kcal100:370, pro100:7.9, fib100:3.5, cup:190, state:"dry", twin:"Brown rice (cooked)"},
  {name:"Pasta (dry)", alias:"spaghetti noodles uncooked", kcal100:371, pro100:13, fib100:3.2, state:"dry", twin:"Pasta, cooked plain"},
  {name:"Oatmeal, cooked with water", alias:"porridge oats", kcal100:71, pro100:2.5, fib100:1.7, cup:234, state:"cooked", twin:"Oats, rolled (dry)"},
  {name:"Black beans (cooked or canned, drained)", alias:"beans", kcal100:132, pro100:8.9, fib100:8.7, cup:172, state:"cooked", twin:"Black beans (dry)"},
  {name:"Black beans (dry)", alias:"beans uncooked", kcal100:341, pro100:21.6, fib100:15.5, cup:194, state:"dry", twin:"Black beans (cooked or canned, drained)"},
].map((f,i)=>({...f, id:"tw"+i, source:"built-in"}));
BUILTIN_FOODS.push(...TWIN_FOODS);

/* Starting quick meals (estimates from Kan's usual plates) */
const STARTER_MEALS = [
  {name:"Protein pancakes + 2 eggs + 2 sausages", kcal:780, pro:65},
  {name:"Oats, banana, yogurt, cottage cheese, protein", kcal:650, pro:55},
  {name:"Sweet potato, spinach + ground chicken", kcal:420, pro:42},
  {name:"Protein bagel + cream cheese", kcal:310, pro:18},
  {name:"Protein shake (1 scoop, water)", kcal:120, pro:24},
];

/* v67: More ideas. Canadian chain menu items, typed from each chain's own published Canadian nutrition data and checked
   20 Oct 2026. Per serving (one item as sold). Not in search and never saved as a food; ids are append-only (ch0, ch1, ...)
   like the other lists, because logged entries point at them. Fibre only where the chain gives it. */
const CHAIN_INFO = {
  "McDonald's": { src: "McDonald's Canada nutrition info", checked: '2026-10-20' },
  'Tim Hortons': { src: 'Tim Hortons Canada menu data (with default toppings)', checked: '2026-10-20' },
  'Subway': { src: 'Subway Canada nutrition guide', checked: '2026-10-20', note: '6-inch subs are on multigrain bread with veggies, no cheese or sauce. A footlong is 2 servings; cheddar adds about 45 kcal and 3 g protein per 6-inch.' },
};
const CHAIN_FOODS = [
  ...[["Hamburger",240,12,2],["Cheeseburger",290,14,2],["McDouble",380,21,2],["Junior Chicken",380,12,2],["Big Mac",570,24,3],["Double Cheeseburger",420,24,2],
    ["Quarter Pounder with Cheese",530,29,2],["Double Quarter Pounder with Cheese",750,47,3],["Egg McMuffin",290,16,2],["Chicken McMuffin",360,14,2],["Sausage 'N Egg McMuffin",440,20,2],
    ["Bacon 'N Egg McMuffin",310,16,2],["Egg 'N Cheese McMuffin",280,14,2],["Breakfast Burrito",290,13,1],["Hash Browns",160,1,2],["McCrispy",520,29,2],["Grilled Chicken Sandwich",400,31,2],
    ["Spicy Grilled Chicken Sandwich",380,31,2],["McChicken",480,16,3],["6 Chicken McNuggets",250,16,0],["10 Chicken McNuggets",410,26,0],["Chicken & Bacon McWrap (grilled)",480,33,2],
    ["Sweet Chili McWrap (grilled)",460,30,2],["Creamy Chipotle Chicken McWrap (grilled)",550,31,3],["Caesar and Bacon McWrap (grilled)",490,32,2],["Spicy Buffalo Snack Wrap (grilled)",240,18,1],
    ["Ranch Chicken Snack Wrap (grilled)",260,18,1],["Filet-O-Fish",400,14,1],["Fries, small",240,3,3],["Fries, medium",350,4,4],["Apple Slices",35,0,1],["1% milk, 250 ml",110,9,0],
    ["Latte, 2%, medium",170,11,0],["Hotcakes (no syrup or butter)",350,8,3],["Poutine",870,21,5]].map(x => ["McDonald's", ...x]),
  ...[["Grilled Chicken Caesar Wrap",471,34,2],["Grilled Buffalo Chicken Wrap",391,29,2],["Grilled Chipotle Cheddar Chicken Wrap",420,28,2],["Slow-Cooked Chicken Bacon Ranch Wrap",420,27,2],
    ["Crispy Chicken Bacon Ranch Wrap",530,24,4],["Steak Classic Breakfast Wrap",450,24,3],["Bacon Farmer's Wrap",534,18,3],["Sausage Farmer's Wrap",655,20,3],["Protein Bagel (plain)",280,20,3],
    ["Bagel BELT",565,27,7],["Chili, regular",310,19,4],["Chili, large",430,27,6],["Chicken Noodle Soup, regular",140,9,1],["Chicken Noodle Soup, large",190,10,2],["Turkey Bacon Club",500,27,3],
    ["Tuscan Chicken Toasted Sandwich",530,30,4],["Montreal Smoked Meat Toasted Sandwich",610,28,4],["Southwest Beef & Cheddar Toasted Sandwich",530,25,5],["Ham & Cheddar Artisan Sandwich",520,25,3],
    ["Greek Yogurt Parfait",252,8,3],["Plain Oatmeal, regular",161,6,4],["Latte, medium",140,10,0],["Bacon Maple Timwich",410,17,1]].map(x => ['Tim Hortons', ...x]),
  ...[["Rotisserie-Style Chicken 6-inch",310,25],["Turkey Breast 6-inch",280,19],["Steak & Cheese 6-inch",360,24],["Sweet Onion Chicken Teriyaki 6-inch",360,23],["Black Forest Ham 6-inch",290,18],
    ["Tuna 6-inch",440,19],["Veggie Delite 6-inch",210,10],["Italian B.M.T. 6-inch",410,20],["Rotisserie-Style Chicken Salad",150,20],["Grilled Chicken Salad",110,14],
    ["Sweet Onion Chicken Teriyaki Salad",240,18],["Sweet Onion Chicken Teriyaki Rice Bowl",490,23],["Shawarma Chicken Rice Bowl",750,30],["Jerk-Spiced Chicken Rice Bowl",670,25]].map(x => ['Subway', ...x]),
].map(([chain, item, k, p, fb], i) => { const f = { id: 'ch' + i, name: `${chain} ${item}`, item, chain, brand: chain, source: 'chain', kcalServ: k, proServ: p };
  if (fb != null) f.fibServ = fb; return f; });

/* v67: simple high-protein meals and snacks to make at home, built only from the built-in foods above (worked out when shown).
   snack: a lighter pick for the evening (after about 7 pm, these come first). Keys are kept stable: logged entries point at them. */
const HOME_IDEAS = [
  { key: 'yogbowl', what: '1 cup Greek yogurt, ½ cup blueberries', name: 'Greek yogurt bowl', snack: true, items: [['Greek yogurt, plain 0%', 1, 'cup'], ['Blueberries', 0.5, 'cup']] },
  { key: 'cottage', what: '1 cup cottage cheese, ½ cup blueberries', name: 'Cottage cheese and berries', snack: true, items: [['Cottage cheese, 2%', 1, 'cup'], ['Blueberries', 0.5, 'cup']] },
  { key: 'whites', what: '6 egg whites, 1 cup spinach', name: 'Egg white and spinach scramble', snack: true, items: [['Egg white, large', 6, 'piece'], ['Spinach (raw)', 1, 'cup']] },
  { key: 'tunatoast', what: '1 can tuna on a slice of whole wheat toast', name: 'Tuna on toast', snack: true, items: [['Tuna, canned in water (drained)', 1, 'piece'], ['Whole wheat bread', 1, 'piece']] },
  { key: 'boiledeggs', what: '2 large eggs', name: 'Two boiled eggs', snack: true, items: [['Egg, large', 2, 'piece']] },
  { key: 'milkshake', what: '1 cup 2% milk and a banana', name: 'Glass of milk and a banana', snack: true, items: [['Milk, 2%', 1, 'cup'], ['Banana', 1, 'piece']] },
  { key: 'chickenrice', what: '150 g cooked chicken breast, 1 cup rice, 1 cup broccoli', name: 'Chicken rice bowl', items: [['Chicken breast (cooked)', 150, 'g'], ['White rice (cooked)', 1, 'cup'], ['Broccoli (raw)', 1, 'cup']] },
  { key: 'eggstoast', what: '3 eggs on 2 slices of whole wheat toast', name: 'Eggs on toast', items: [['Egg, large', 3, 'piece'], ['Whole wheat bread', 2, 'piece']] },
  { key: 'tunasand', what: '1 can tuna, 2 slices whole wheat bread, spinach', name: 'Tuna sandwich', items: [['Tuna, canned in water (drained)', 1, 'piece'], ['Whole wheat bread', 2, 'piece'], ['Spinach (raw)', 1, 'cup']] },
  { key: 'salmon', what: '1 salmon fillet, 1 baked sweet potato, 1 cup broccoli', name: 'Salmon, sweet potato and broccoli', items: [['Salmon, cooked', 1, 'piece'], ['Sweet potato, baked', 1, 'piece'], ['Broccoli (raw)', 1, 'cup']] },
  { key: 'groundchicken', what: '150 g cooked ground chicken, 1 cup rice, 1 cup mixed veg', name: 'Ground chicken, rice and veggies', items: [['Ground chicken, extra lean (cooked)', 150, 'g'], ['White rice (cooked)', 1, 'cup'], ['Mixed vegetables, frozen', 1, 'cup']] },
  { key: 'basarice', what: '1 basa fillet, 1 cup brown rice, 1 cup mixed veg', name: 'Basa with brown rice', items: [['Basa / swai fillet (cooked)', 1, 'piece'], ['Brown rice (cooked)', 1, 'cup'], ['Mixed vegetables, frozen', 1, 'cup']] },
  { key: 'steakpotato', what: '150 g steak, 1 boiled potato, 1 cup broccoli', name: 'Steak and potatoes', items: [['Steak, cooked', 150, 'g'], ['Potato, white (boiled)', 1, 'piece'], ['Broccoli (raw)', 1, 'cup']] },
  { key: 'protoats', what: '40 g oats, 1 cup Greek yogurt, ½ cup milk, ½ cup blueberries', name: 'Yogurt overnight oats', items: [['Oats, rolled (dry)', 40, 'g'], ['Greek yogurt, plain 0%', 1, 'cup'], ['Milk, 2%', 0.5, 'cup'], ['Blueberries', 0.5, 'cup']] },
  { key: 'beanseggs', what: '½ cup black beans, 2 eggs, 1 slice toast', name: 'Black beans and eggs', items: [['Black beans (cooked or canned, drained)', 0.5, 'cup'], ['Egg, large', 2, 'piece'], ['Whole wheat bread', 1, 'piece']] },
];

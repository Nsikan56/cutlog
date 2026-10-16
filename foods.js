/* Built-in whole foods. Values per 100 g, approximate (USDA FoodData Central).
   piece: grams in one typical item; cup: grams in one cup. */
const BUILTIN_FOODS = [
  {name:"Sweet potato (raw weight)", kcal100:86, pro100:1.6, piece:130, pieceLabel:"medium potato", cup:133},
  {name:"Sweet potato, baked", kcal100:90, pro100:2.0, piece:115, pieceLabel:"medium potato", cup:200},
  {name:"Potato, white (raw)", kcal100:77, pro100:2.0, piece:213, pieceLabel:"medium potato"},
  {name:"Egg, large", kcal100:143, pro100:12.6, piece:50, pieceLabel:"egg"},
  {name:"Egg white, large", kcal100:52, pro100:10.9, piece:33, pieceLabel:"white", cup:243},
  {name:"Ground chicken, extra lean (raw)", kcal100:140, pro100:20},
  {name:"Ground beef, extra lean (raw)", kcal100:137, pro100:21},
  {name:"Chicken breast (raw)", kcal100:120, pro100:22.5, piece:200, pieceLabel:"breast"},
  {name:"Chicken breast (cooked)", kcal100:165, pro100:31},
  {name:"Basa / swai fillet (raw)", kcal100:70, pro100:15, piece:150, pieceLabel:"fillet"},
  {name:"Salmon, Atlantic (raw)", kcal100:208, pro100:20.4, piece:170, pieceLabel:"fillet"},
  {name:"Tuna, canned in water (drained)", kcal100:116, pro100:25.5, piece:120, pieceLabel:"can"},
  {name:"Spinach (raw)", kcal100:23, pro100:2.9, cup:30},
  {name:"Broccoli (raw)", kcal100:34, pro100:2.8, cup:91},
  {name:"Mixed vegetables, frozen", kcal100:64, pro100:2.9, cup:135},
  {name:"Banana", kcal100:89, pro100:1.1, piece:118, pieceLabel:"medium banana"},
  {name:"Blueberries", kcal100:57, pro100:0.7, cup:148},
  {name:"Apple", kcal100:52, pro100:0.3, piece:182, pieceLabel:"medium apple"},
  {name:"Avocado", kcal100:160, pro100:2.0, piece:150, pieceLabel:"avocado (flesh)"},
  {name:"Oats, rolled (dry)", kcal100:379, pro100:13.2, cup:80},
  {name:"White rice (cooked)", kcal100:130, pro100:2.7, cup:158},
  {name:"Brown rice (cooked)", kcal100:123, pro100:2.7, cup:195},
  {name:"Whole wheat bread", kcal100:247, pro100:13, piece:32, pieceLabel:"slice"},
  {name:"Greek yogurt, plain 0%", kcal100:59, pro100:10.3, cup:245},
  {name:"Cottage cheese, 2%", kcal100:84, pro100:11, cup:226},
  {name:"Milk, 2%", kcal100:50, pro100:3.3, cup:244},
  {name:"Peanut butter", kcal100:588, pro100:25},
  {name:"Olive oil", kcal100:884, pro100:0},
  {name:"Butter", kcal100:717, pro100:0.9},
  {name:"Cream cheese, light", kcal100:200, pro100:7.9},
].map((f,i)=>({...f, id:"b"+i, source:"built-in"}));

/* Starting quick meals (estimates from Kan's usual plates) */
const STARTER_MEALS = [
  {name:"Protein pancakes + 2 eggs + 2 sausages", kcal:780, pro:65},
  {name:"Oats, banana, yogurt, cottage cheese, protein", kcal:650, pro:55},
  {name:"Sweet potato, spinach + ground chicken", kcal:420, pro:42},
  {name:"Protein bagel + cream cheese", kcal:310, pro:18},
  {name:"Protein shake (1 scoop, water)", kcal:120, pro:24},
];
